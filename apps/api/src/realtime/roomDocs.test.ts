import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Db } from "@coderoom/db";
import { MessageType, RoomDocManager, spillKey } from "./roomDocs.js";

const ROOM = "00000000-0000-4000-8000-0000000000aa";

/**
 * Minimal Drizzle stand-in holding one room_documents row. Upserts (plain or inside a transaction)
 * can be made to fail N times and to take `writeDelayMs`.
 */
function fakeDb(opts: { failFirst?: number; writeDelayMs?: number } = {}) {
  let stored: Uint8Array | null = null;
  const writes: Uint8Array[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failuresLeft = opts.failFirst ?? 0;

  const selectChain = () => {
    const rows = async () => (stored ? [{ state: stored }] : []);
    return { from: () => ({ where: () => ({ limit: rows, for: rows }) }) };
  };
  const insertChain = () => ({
    values: (v: { state: Uint8Array }) => ({
      onConflictDoUpdate: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, opts.writeDelayMs ?? 0));
          if (failuresLeft-- > 0) throw new Error("db unavailable");
          stored = v.state;
          writes.push(v.state);
        } finally {
          inFlight--;
        }
      },
    }),
  });
  const db = {
    select: selectChain,
    insert: insertChain,
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ select: selectChain, insert: insertChain }),
  };
  return {
    db: db as unknown as Db,
    writes,
    stored: () => stored,
    maxInFlight: () => maxInFlight,
    heal: () => (failuresLeft = 0),
  };
}

/** Redis stand-in: pub/sub calls are no-ops, plus a key/value store for the unsaved-edits spill. */
function fakeRedis(store = new Map<string, Buffer>()) {
  const redis = {
    on() {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    publish: async () => 0,
    getBuffer: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: Buffer) => (store.set(k, v), "OK"),
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  };
  return { redis: redis as unknown as Redis, store };
}

function fakeSocket() {
  const sent: Uint8Array[] = [];
  return { ws: { readyState: 1, send: (m: Uint8Array) => sent.push(m), terminate() {} } as unknown as WebSocket, sent };
}

function manager(db: Db, opts: { debounceMs?: number; store?: Map<string, Buffer> } = {}) {
  const { redis } = fakeRedis(opts.store);
  return new RoomDocManager({
    db,
    pub: redis,
    sub: redis,
    instanceId: "test",
    persistDebounceMs: opts.debounceMs ?? 10,
    retryBaseMs: 10,
  });
}

/** A y-websocket "update" message that inserts `text` at the start of the shared code. */
function editMessage(text: string) {
  const client = new Y.Doc();
  client.getText("code").insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return encoding.toUint8Array(encoder);
}

function syncStep1Message() {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

const textOf = (state: Uint8Array | null | undefined) => {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc.getText("code").toString();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await sleep(10);
  }
}

describe("RoomDocManager persistence", () => {
  it("retries a failed save until it succeeds", async () => {
    const db = fakeDb({ failFirst: 2 });
    const docs = manager(db.db);
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("hello"));
    await waitFor(() => db.writes.length === 1);
    expect(textOf(db.writes[0])).toBe("hello");
  });

  it("never runs two saves for a room at once", async () => {
    const db = fakeDb({ writeDelayMs: 50 });
    const docs = manager(db.db, { debounceMs: 1 });
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    for (const ch of "abcde") {
      docs.handleClientMessage(entry, ws, editMessage(ch));
      await sleep(15);
    }
    await waitFor(() => textOf(db.stored()).length === 5);
    expect(db.maxInFlight()).toBe(1);
  });

  it("waits for an in-flight save on unload, and saves again if that save fails", async () => {
    // The debounce save starts (dirty cleared) and is still writing when the last client leaves;
    // that write then fails. Previously unload saw dirty=false and destroyed the doc.
    const db = fakeDb({ failFirst: 1, writeDelayMs: 80 });
    const docs = manager(db.db, { debounceMs: 1 });
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("in-flight"));
    await sleep(20); // save is now in flight
    await docs.disconnect(ROOM, ws);
    expect(textOf(db.stored())).toBe("in-flight");
    expect(docs.retainedCount).toBe(0);
  });

  it("keeps unsaved edits after final retries fail, and writes them once the DB recovers", async () => {
    const db = fakeDb({ failFirst: 1000 });
    const store = new Map<string, Buffer>();
    const docs = manager(db.db, { debounceMs: 60_000, store }); // only the unload path saves
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("precious"));
    await docs.disconnect(ROOM, ws);
    expect(docs.retainedCount).toBe(1); // not dropped
    await waitFor(() => store.has(spillKey(ROOM))); // and spilled for other processes
    expect(textOf(store.get(spillKey(ROOM)))).toBe("precious");

    db.heal();
    await waitFor(() => docs.retainedCount === 0);
    expect(textOf(db.stored())).toBe("precious");
    expect(store.has(spillKey(ROOM))).toBe(false);
  });

  it("a new process recovers spilled edits when the room is loaded again", async () => {
    const db = fakeDb({ failFirst: 1000 });
    const store = new Map<string, Buffer>();
    const first = manager(db.db, { debounceMs: 60_000, store });
    const a = fakeSocket();
    const entry = await first.connect(ROOM, a.ws, { readOnly: false });
    first.handleClientMessage(entry, a.ws, editMessage("survives"));
    await first.disconnect(ROOM, a.ws);
    await first.closeAll(); // "process exits" with the edits only in the Redis spill
    await waitFor(() => store.has(spillKey(ROOM)));

    db.heal();
    const second = manager(db.db, { debounceMs: 1, store });
    const b = fakeSocket();
    const reloaded = await second.connect(ROOM, b.ws, { readOnly: false });
    expect(reloaded.doc.getText("code").toString()).toBe("survives");
    await waitFor(() => textOf(db.stored()) === "survives"); // written back to Postgres
    await waitFor(() => !store.has(spillKey(ROOM))); // and the spill cleaned up
  });
});

describe("RoomDocManager read-only rooms", () => {
  it("drops document writes but still answers sync requests", async () => {
    const db = fakeDb();
    const docs = manager(db.db);
    const { ws, sent } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("before"));
    docs.setReadOnly(ROOM);
    docs.handleClientMessage(entry, ws, editMessage("after "));
    expect(entry.doc.getText("code").toString()).toBe("before");
    expect(docs.writableRoomIds()).toEqual([]);

    const sentBefore = sent.length;
    docs.handleClientMessage(entry, ws, syncStep1Message());
    expect(sent.length).toBe(sentBefore + 1); // sync step 2 reply
  });

  it("connections opened on an ended room are read-only from the start", async () => {
    const db = fakeDb();
    const docs = manager(db.db);
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: true });
    docs.handleClientMessage(entry, ws, editMessage("nope"));
    expect(entry.doc.getText("code").toString()).toBe("");
  });
});
