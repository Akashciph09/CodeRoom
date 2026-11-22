import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Db } from "@coderoom/db";
import { MessageType, RoomDocManager } from "./roomDocs.js";

const ROOM = "00000000-0000-4000-8000-0000000000aa";

/** Minimal Drizzle stand-in: load returns nothing; upserts can be made to fail N times. */
function fakeDb(failFirst: number, writeDelayMs = 0) {
  const writes: Uint8Array[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failuresLeft = failFirst;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({
      values: (v: { state: Uint8Array }) => ({
        onConflictDoUpdate: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await new Promise((r) => setTimeout(r, writeDelayMs));
            if (failuresLeft-- > 0) throw new Error("db unavailable");
            writes.push(v.state);
          } finally {
            inFlight--;
          }
        },
      }),
    }),
  };
  return { db: db as unknown as Db, writes, maxInFlight: () => maxInFlight };
}

const fakeRedis = () =>
  ({ on() {}, subscribe: async () => {}, unsubscribe: async () => {}, publish: async () => 0 }) as unknown as Redis;

function fakeSocket() {
  const sent: Uint8Array[] = [];
  return { ws: { readyState: 1, send: (m: Uint8Array) => sent.push(m), terminate() {} } as unknown as WebSocket, sent };
}

function manager(db: Db, debounceMs = 10) {
  return new RoomDocManager({ db, pub: fakeRedis(), sub: fakeRedis(), instanceId: "test", persistDebounceMs: debounceMs });
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

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText("code").toString();
};

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("RoomDocManager persistence", () => {
  it("retries a failed save until it succeeds", async () => {
    const { db, writes } = fakeDb(2);
    const docs = manager(db);
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("hello"));
    await waitFor(() => writes.length === 1);
    expect(textOf(writes[0]!)).toBe("hello");
  });

  it("never runs two saves for a room at once", async () => {
    const { db, writes, maxInFlight } = fakeDb(0, 50);
    const docs = manager(db, 1);
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    for (const ch of "abcde") {
      docs.handleClientMessage(entry, ws, editMessage(ch));
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => writes.length > 0 && textOf(writes.at(-1)!).length === 5);
    expect(maxInFlight()).toBe(1);
  });

  it("retries the final save when the last client leaves", async () => {
    const { db, writes } = fakeDb(2);
    const docs = manager(db, 60_000); // debounce never fires; only the unload save runs
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("bye"));
    await docs.disconnect(ROOM, ws);
    expect(writes).toHaveLength(1);
    expect(textOf(writes[0]!)).toBe("bye");
  });
});

describe("RoomDocManager read-only rooms", () => {
  it("drops document writes but still answers sync requests", async () => {
    const { db } = fakeDb(0);
    const docs = manager(db);
    const { ws, sent } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: false });

    docs.handleClientMessage(entry, ws, editMessage("before"));
    docs.setReadOnly(ROOM);
    docs.handleClientMessage(entry, ws, editMessage("after "));
    expect(entry.doc.getText("code").toString()).toBe("before");

    const sentBefore = sent.length;
    docs.handleClientMessage(entry, ws, syncStep1Message());
    expect(sent.length).toBe(sentBefore + 1); // sync step 2 reply
  });

  it("connections opened on an ended room are read-only from the start", async () => {
    const { db } = fakeDb(0);
    const docs = manager(db);
    const { ws } = fakeSocket();
    const entry = await docs.connect(ROOM, ws, { readOnly: true });
    docs.handleClientMessage(entry, ws, editMessage("nope"));
    expect(entry.doc.getText("code").toString()).toBe("");
  });
});
