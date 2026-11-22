import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { eq, roomDocuments, sql, type Db } from "@coderoom/db";
import { decodeFrame, docChannel, DOC_CHANNEL_PREFIX, encodeFrame, FrameKind } from "./busFrames.js";

/** y-websocket message types. */
export const MessageType = { Sync: 0, Awareness: 1 } as const;

/** Origins tag where a change came from, so we don't echo bus traffic back onto the bus. */
const BUS_ORIGIN = Symbol("bus");
const PERSISTENCE_ORIGIN = Symbol("persistence");

export interface SharedRoomDoc {
  roomId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Local connections → awareness client ids each one controls (removed when it disconnects). */
  conns: Map<WebSocket, Set<number>>;
}

interface Entry extends SharedRoomDoc {
  /** Has changes not yet confirmed written to Postgres. */
  dirty: boolean;
  persistTimer?: NodeJS.Timeout;
  /** Saves run one at a time, so an older snapshot can never overwrite a newer one. */
  saving: Promise<void>;
  saveFailures: number;
  /** Room ended: clients may still read and see cursors, but their document updates are dropped. */
  readOnly: boolean;
  /** Loaded state included a Redis spill of previously unsaved edits; delete the spill once saved. */
  recoveredSpill: boolean;
}

/** State whose final save failed after the doc was unloaded: retried in the background while this process lives (plus a best-effort Redis spill). */
interface Retained {
  state: Uint8Array;
  failures: number;
  timer?: NodeJS.Timeout;
}

const UNLOAD_SAVE_ATTEMPTS = 3;
const SPILL_TTL_SECONDS = 7 * 24 * 3600;
export const spillKey = (roomId: string) => `yjs:unsaved:${roomId}`;
const backoffMs = (failures: number, baseMs = 500) => Math.min(30_000, baseMs * 2 ** (failures - 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RoomDocManagerOptions {
  db: Db;
  pub: Redis;
  sub: Redis;
  instanceId: string;
  persistDebounceMs: number;
  /** Base delay for save retries (tests shorten it). */
  retryBaseMs?: number;
}

/**
 * Owns the in-memory Yjs documents for rooms that have at least one connection on THIS instance.
 *  - Loads state from Postgres on first connect, persists on a debounce and when the last client leaves.
 *  - Fans updates and awareness out to other gateway instances over Redis pub/sub, so clients of the
 *    same room can be connected to different instances.
 */
export class RoomDocManager {
  private readonly loading = new Map<string, Promise<Entry>>();
  private readonly loaded = new Map<string, Entry>();
  private readonly unloading = new Map<string, Promise<void>>();
  private readonly retained = new Map<string, Retained>();

  constructor(private readonly opts: RoomDocManagerOptions) {
    opts.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const name = channel.toString();
      if (name.startsWith(DOC_CHANNEL_PREFIX)) this.onBusMessage(name.slice(DOC_CHANNEL_PREFIX.length), message);
    });
  }

  get roomCount() {
    return this.loaded.size;
  }

  /** Rooms with unsaved state still being retried after unload (for health/metrics and tests). */
  get retainedCount() {
    return this.retained.size;
  }

  /** Loaded rooms that still accept writes — the gateway's status reconciler checks these against the DB. */
  writableRoomIds(): string[] {
    return [...this.loaded.values()].filter((e) => !e.readOnly).map((e) => e.roomId);
  }

  private backoff(failures: number) {
    return backoffMs(failures, this.opts.retryBaseMs);
  }

  /** Register a connection for a room, loading the doc if needed. The conn counts immediately (no unload race). */
  async connect(roomId: string, ws: WebSocket, opts: { readOnly: boolean }): Promise<SharedRoomDoc> {
    await this.unloading.get(roomId);
    let entry = this.loaded.get(roomId);
    if (!entry) {
      let pending = this.loading.get(roomId);
      if (!pending) {
        pending = this.load(roomId);
        this.loading.set(roomId, pending);
        pending.catch(() => this.loading.delete(roomId));
      }
      entry = await pending;
    }
    if (opts.readOnly) entry.readOnly = true;
    entry.conns.set(ws, new Set());
    return entry;
  }

  /** The room was ended: stop accepting document edits from every client on this instance. */
  setReadOnly(roomId: string) {
    const entry = this.loaded.get(roomId);
    if (entry) entry.readOnly = true;
  }

  async disconnect(roomId: string, ws: WebSocket) {
    const entry = this.loaded.get(roomId);
    if (!entry) return;
    const controlled = entry.conns.get(ws);
    entry.conns.delete(ws);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(entry.awareness, [...controlled], null);
    }
    if (entry.conns.size === 0) {
      const done = this.unload(entry).finally(() => this.unloading.delete(roomId));
      this.unloading.set(roomId, done);
      await done;
    }
  }

  /** Apply one y-websocket protocol message from a client and reply if the protocol requires it. */
  handleClientMessage(shared: SharedRoomDoc, ws: WebSocket, message: Uint8Array) {
    const entry = shared as Entry;
    if (!entry.conns.has(ws)) return; // already disconnected
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MessageType.Sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Sync);
      const subtype = decoding.readVarUint(decoder);
      if (subtype === syncProtocol.messageYjsSyncStep1) {
        // A client asking for state is always fine (read access).
        syncProtocol.readSyncStep1(decoder, encoder, entry.doc);
      } else if (subtype === syncProtocol.messageYjsSyncStep2 || subtype === syncProtocol.messageYjsUpdate) {
        // Writes. Enforced server-side: a closed room drops them no matter what the client UI does.
        if (!entry.readOnly) syncProtocol.readUpdate(decoder, entry.doc, ws);
      } else {
        throw new Error(`unsupported sync message ${subtype}`);
      }
      // Only reply when the message produced a response (sync step 1 → step 2).
      if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
    } else if (type === MessageType.Awareness) {
      awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(decoder), ws);
    } else {
      throw new Error(`unsupported message type ${type}`);
    }
  }

  /** Initial handshake for a new connection: our sync step 1 + current awareness states. */
  greet(entry: SharedRoomDoc, ws: WebSocket) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    syncProtocol.writeSyncStep1(encoder, entry.doc);
    send(ws, encoding.toUint8Array(encoder));

    const states = entry.awareness.getStates();
    if (states.size > 0) {
      send(ws, awarenessMessage(entry.awareness, [...states.keys()]));
    }
  }

  /** Persist and drop every loaded doc (graceful shutdown). */
  async closeAll() {
    await Promise.all([...this.loaded.values()].map((e) => this.unload(e)));
    // Anything still retained stays in its Redis spill for the next process to recover.
    for (const r of this.retained.values()) clearTimeout(r.timer);
  }

  // ---------------------------------------------------------------------------------------------

  private async load(roomId: string): Promise<Entry> {
    const doc = new Y.Doc({ gc: true });
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // the server is not a participant

    const [row] = await this.opts.db
      .select({ state: roomDocuments.state })
      .from(roomDocuments)
      .where(eq(roomDocuments.roomId, roomId))
      .limit(1);
    if (row) Y.applyUpdate(doc, row.state, PERSISTENCE_ORIGIN);

    // Edits whose save failed earlier are merged back in (Yjs merges are idempotent, so overlap is harmless):
    // first anything this process still retains, then any Redis spill (e.g. from a process that has since died).
    let recovered = false;
    const retained = this.retained.get(roomId);
    if (retained) {
      clearTimeout(retained.timer);
      this.retained.delete(roomId);
      Y.applyUpdate(doc, retained.state, PERSISTENCE_ORIGIN);
      recovered = true;
    }
    const spilled = await this.opts.pub.getBuffer(spillKey(roomId)).catch(() => null);
    if (spilled) {
      Y.applyUpdate(doc, new Uint8Array(spilled), PERSISTENCE_ORIGIN);
      recovered = true;
    }

    const entry: Entry = {
      roomId,
      doc,
      awareness,
      conns: new Map(),
      dirty: false,
      saving: Promise.resolve(),
      saveFailures: 0,
      readOnly: false,
      recoveredSpill: spilled !== null,
    };

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Sync);
      syncProtocol.writeUpdate(encoder, update);
      broadcast(entry, encoding.toUint8Array(encoder));

      if (origin === PERSISTENCE_ORIGIN) return;
      if (origin !== BUS_ORIGIN) this.publish(roomId, FrameKind.Update, update);
      this.markDirty(entry);
    });

    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const conn = origin as WebSocket;
        const controlled = entry.conns.get(conn);
        if (controlled) {
          added.forEach((id) => controlled.add(id));
          removed.forEach((id) => controlled.delete(id));
        }
        const changed = [...added, ...updated, ...removed];
        broadcast(entry, awarenessMessage(awareness, changed));
        if (origin !== BUS_ORIGIN) {
          this.publish(roomId, FrameKind.Awareness, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        }
      },
    );

    this.loaded.set(roomId, entry);
    this.loading.delete(roomId);
    await this.opts.sub.subscribe(docChannel(roomId));
    // Ask other instances for anything we don't have yet (edits not yet persisted).
    this.publish(roomId, FrameKind.SyncRequest, Y.encodeStateVector(doc));
    if (recovered) this.markDirty(entry); // write the recovered edits back to Postgres
    return entry;
  }

  private async unload(entry: Entry) {
    this.loaded.delete(entry.roomId);
    clearTimeout(entry.persistTimer);
    await this.opts.sub.unsubscribe(docChannel(entry.roomId)).catch(() => {});
    try {
      // A save may be in flight with `dirty` already cleared. Wait for it: if it fails, `dirty` comes back.
      await entry.saving.catch(() => {});
      for (let attempt = 1; entry.dirty && attempt <= UNLOAD_SAVE_ATTEMPTS; attempt++) {
        try {
          await this.persist(entry);
        } catch (err) {
          console.error(`final save of room ${entry.roomId} failed (attempt ${attempt}/${UNLOAD_SAVE_ATTEMPTS}):`, err);
          if (attempt < UNLOAD_SAVE_ATTEMPTS) await sleep(this.backoff(attempt));
        }
      }
      // Still unsaved: keep the state (memory + best-effort Redis spill) and keep retrying after the doc is gone.
      if (entry.dirty) this.retain(entry.roomId, Y.encodeStateAsUpdate(entry.doc));
    } finally {
      entry.awareness.destroy();
      entry.doc.destroy();
    }
  }

  /**
   * Hold unsaved state for an unloaded room: in memory (retried with backoff until written) and,
   * best effort, spilled to Redis so it survives this process. The next load of the room merges both.
   */
  private retain(roomId: string, state: Uint8Array) {
    const prev = this.retained.get(roomId);
    if (prev) clearTimeout(prev.timer);
    const r: Retained = { state: prev ? Y.mergeUpdates([prev.state, state]) : state, failures: prev?.failures ?? 0 };
    this.retained.set(roomId, r);
    console.error(`room ${roomId}: final save failed; keeping unsaved edits and retrying in the background`);
    this.opts.pub
      .set(spillKey(roomId), Buffer.from(r.state), "EX", SPILL_TTL_SECONDS)
      .catch((err) => console.error(`room ${roomId}: could not spill unsaved edits to Redis:`, err));
    this.scheduleRetained(roomId, r);
  }

  private scheduleRetained(roomId: string, r: Retained) {
    r.timer = setTimeout(async () => {
      if (this.retained.get(roomId) !== r) return; // room was reloaded and took the state over
      try {
        await this.writeMerged(roomId, r.state);
        if (this.retained.get(roomId) === r) {
          this.retained.delete(roomId);
          await this.opts.pub.del(spillKey(roomId)).catch(() => {});
        }
      } catch (err) {
        r.failures++;
        console.error(`room ${roomId}: background save failed (${r.failures}):`, err);
        if (this.retained.get(roomId) === r) this.scheduleRetained(roomId, r);
      }
    }, this.backoff(r.failures + 1));
  }

  /** Save state for a room that is no longer loaded here (retained after failed final saves). */
  private async writeMerged(roomId: string, state: Uint8Array) {
    await this.lockedMergeWrite(roomId, (stored) => (stored ? Y.mergeUpdates([stored, state]) : state));
  }

  /**
   * The only way room_documents is written. Several instances can save the same room, and any of them
   * may have missed an update, so no save may blindly overwrite the row. Instead, per room:
   *   1. take a transaction-scoped advisory lock — it serializes writers across instances and, unlike a
   *      row lock, also works for the very first save when no row exists yet;
   *   2. read the stored snapshot; 3. merge (Yjs merges are commutative and idempotent); 4. write.
   * The lock is released automatically at commit/rollback.
   */
  private async lockedMergeWrite(roomId: string, merge: (stored: Uint8Array | null) => Uint8Array) {
    await this.opts.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`);
      const [row] = await tx
        .select({ state: roomDocuments.state })
        .from(roomDocuments)
        .where(eq(roomDocuments.roomId, roomId))
        .limit(1);
      const next = merge(row?.state ?? null);
      await tx
        .insert(roomDocuments)
        .values({ roomId, state: next })
        .onConflictDoUpdate({ target: roomDocuments.roomId, set: { state: next, updatedAt: sql`now()` } });
    });
  }

  private markDirty(entry: Entry) {
    entry.dirty = true;
    this.schedulePersist(entry, this.opts.persistDebounceMs);
  }

  private schedulePersist(entry: Entry, delayMs: number) {
    clearTimeout(entry.persistTimer);
    entry.persistTimer = setTimeout(() => {
      this.persist(entry).then(
        () => (entry.saveFailures = 0),
        (err) => {
          entry.saveFailures++;
          const retryIn = this.backoff(entry.saveFailures);
          console.error(`save of room ${entry.roomId} failed; retrying in ${retryIn}ms:`, err);
          // Still loaded and still dirty → try again. (If it unloaded, unload() does its own retries.)
          if (this.loaded.get(entry.roomId) === entry && entry.dirty) this.schedulePersist(entry, retryIn);
        },
      );
    }, delayMs);
  }

  /**
   * Save the live doc. Serialized per room on this instance via `entry.saving`, and across instances by
   * the advisory lock in `lockedMergeWrite`. Inside the lock, the stored snapshot is first applied to the
   * live doc — so anything this instance missed is pulled in (and sent to its clients) — and only then is
   * the doc encoded and written. A save can therefore never shrink the stored document.
   * `dirty` is cleared before the write (edits arriving meanwhile set it again) and restored on failure.
   */
  private persist(entry: Entry): Promise<void> {
    const run = async () => {
      if (!entry.dirty) return;
      entry.dirty = false;
      try {
        await this.lockedMergeWrite(entry.roomId, (stored) => {
          if (stored) Y.applyUpdate(entry.doc, stored, PERSISTENCE_ORIGIN);
          return Y.encodeStateAsUpdate(entry.doc);
        });
      } catch (err) {
        entry.dirty = true;
        throw err;
      }
      if (entry.recoveredSpill) {
        // The spilled edits are now in Postgres.
        entry.recoveredSpill = false;
        await this.opts.pub.del(spillKey(entry.roomId)).catch(() => {});
      }
    };
    const next = entry.saving.catch(() => {}).then(run);
    entry.saving = next;
    return next;
  }

  private publish(roomId: string, kind: FrameKind, payload: Uint8Array) {
    const frame = encodeFrame({ origin: this.opts.instanceId, kind, payload });
    this.opts.pub.publish(docChannel(roomId), frame).catch((err) => console.error("bus publish failed:", err));
  }

  private onBusMessage(roomId: string, message: Buffer) {
    const entry = this.loaded.get(roomId);
    if (!entry) return;
    let frame;
    try {
      frame = decodeFrame(message);
    } catch (err) {
      console.error("bad bus frame:", err);
      return;
    }
    if (frame.origin === this.opts.instanceId) return;

    switch (frame.kind) {
      case FrameKind.Update:
        Y.applyUpdate(entry.doc, frame.payload, BUS_ORIGIN);
        break;
      case FrameKind.Awareness:
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, frame.payload, BUS_ORIGIN);
        break;
      case FrameKind.SyncRequest: {
        const diff = Y.encodeStateAsUpdate(entry.doc, frame.payload);
        // An empty Yjs update is 2 bytes; only send real content.
        if (diff.length > 2) this.publish(roomId, FrameKind.Update, diff);
        const states = [...entry.awareness.getStates().keys()];
        if (states.length > 0) {
          this.publish(roomId, FrameKind.Awareness, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, states));
        }
        break;
      }
    }
  }
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Awareness);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

function broadcast(entry: SharedRoomDoc, message: Uint8Array) {
  for (const ws of entry.conns.keys()) send(ws, message);
}

const OPEN = 1;
function send(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState !== OPEN) return;
  ws.send(message, (err) => {
    if (err) ws.terminate();
  });
}
