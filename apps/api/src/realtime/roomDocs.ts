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
  dirty: boolean;
  persistTimer?: NodeJS.Timeout;
}

export interface RoomDocManagerOptions {
  db: Db;
  pub: Redis;
  sub: Redis;
  instanceId: string;
  persistDebounceMs: number;
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

  constructor(private readonly opts: RoomDocManagerOptions) {
    opts.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const name = channel.toString();
      if (name.startsWith(DOC_CHANNEL_PREFIX)) this.onBusMessage(name.slice(DOC_CHANNEL_PREFIX.length), message);
    });
  }

  get roomCount() {
    return this.loaded.size;
  }

  /** Register a connection for a room, loading the doc if needed. The conn counts immediately (no unload race). */
  async connect(roomId: string, ws: WebSocket): Promise<SharedRoomDoc> {
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
    entry.conns.set(ws, new Set());
    return entry;
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
  handleClientMessage(entry: SharedRoomDoc, ws: WebSocket, message: Uint8Array) {
    if (!entry.conns.has(ws)) return; // already disconnected
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MessageType.Sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Sync);
      syncProtocol.readSyncMessage(decoder, encoder, entry.doc, ws);
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

    const entry: Entry = { roomId, doc, awareness, conns: new Map(), dirty: false };

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
    return entry;
  }

  private async unload(entry: Entry) {
    this.loaded.delete(entry.roomId);
    clearTimeout(entry.persistTimer);
    await this.opts.sub.unsubscribe(docChannel(entry.roomId)).catch(() => {});
    try {
      if (entry.dirty) await this.persist(entry);
    } finally {
      entry.awareness.destroy();
      entry.doc.destroy();
    }
  }

  private markDirty(entry: Entry) {
    entry.dirty = true;
    clearTimeout(entry.persistTimer);
    entry.persistTimer = setTimeout(() => {
      this.persist(entry).catch((err) => console.error(`persist ${entry.roomId} failed:`, err));
    }, this.opts.persistDebounceMs);
  }

  private async persist(entry: Entry) {
    entry.dirty = false;
    const state = Y.encodeStateAsUpdate(entry.doc);
    await this.opts.db
      .insert(roomDocuments)
      .values({ roomId: entry.roomId, state })
      .onConflictDoUpdate({ target: roomDocuments.roomId, set: { state, updatedAt: sql`now()` } });
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
