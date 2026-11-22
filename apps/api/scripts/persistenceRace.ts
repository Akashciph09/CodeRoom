/**
 * Real-Postgres check of document save safety across instances (used by realtime-smoke).
 * Two RoomDocManagers share the database but NOT the Redis bus, so neither sees the other's edits —
 * the worst case for "an instance missed an update". Both make the very first save of a room at the
 * same moment (no row exists, so a row lock would have nothing to lock). Both edits must survive.
 */
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createDb, eq, roomDocuments } from "@coderoom/db";
import { MessageType, RoomDocManager } from "../src/realtime/roomDocs.js";

const isolatedBus = () =>
  ({
    on() {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    publish: async () => 0,
    getBuffer: async () => null,
    set: async () => "OK",
    del: async () => 0,
  }) as unknown as Redis;

const socket = () => ({ readyState: 1, send() {}, terminate() {} }) as unknown as WebSocket;

function edit(text: string) {
  const client = new Y.Doc();
  client.getText("code").insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return encoding.toUint8Array(encoder);
}

/** Returns how many of `rounds` concurrent-first-save races kept both edits. */
export async function runPersistenceRace(roomId: string, rounds = 10): Promise<number> {
  const { db, close } = createDb(process.env.DATABASE_URL!, { max: 4 });
  let kept = 0;
  try {
    for (let i = 0; i < rounds; i++) {
      await db.delete(roomDocuments).where(eq(roomDocuments.roomId, roomId));
      const make = (id: string) =>
        new RoomDocManager({ db, pub: isolatedBus(), sub: isolatedBus(), instanceId: id, persistDebounceMs: 1 });
      const [a, b] = [make(`race-a-${i}`), make(`race-b-${i}`)];
      const [wa, wb] = [socket(), socket()];
      const [ea, eb] = await Promise.all([
        a.connect(roomId, wa, { readOnly: false }),
        b.connect(roomId, wb, { readOnly: false }),
      ]);
      a.handleClientMessage(ea, wa, edit(`A${i} `));
      b.handleClientMessage(eb, wb, edit(`B${i} `));
      // Last client leaving flushes and waits for each manager's saves.
      await Promise.all([a.disconnect(roomId, wa), b.disconnect(roomId, wb)]);

      const [row] = await db
        .select({ state: roomDocuments.state })
        .from(roomDocuments)
        .where(eq(roomDocuments.roomId, roomId));
      const doc = new Y.Doc();
      if (row) Y.applyUpdate(doc, row.state);
      const text = doc.getText("code").toString();
      if (text.includes(`A${i} `) && text.includes(`B${i} `)) kept++;
    }
  } finally {
    await db.delete(roomDocuments).where(eq(roomDocuments.roomId, roomId));
    await close();
  }
  return kept;
}
