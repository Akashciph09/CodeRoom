import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import type { ServerEvent } from "@coderoom/shared";
import { RoomEventHub } from "./roomEvents.js";
import { startRoomStatusReconciler } from "./roomStatusReconciler.js";

/** A pub/sub connection stand-in: `publish(raw)` delivers a bus message like Redis would. */
function fakeSub() {
  const emitter = new EventEmitter();
  const sub = Object.assign(emitter, { psubscribe: vi.fn(async () => 1) }) as unknown as Redis;
  return { sub, publish: (event: object) => emitter.emit("pmessage", "room:*", "room:x:events", JSON.stringify(event)) };
}

function fakeSocket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, sent: [] as ServerEvent[] });
  (ws as unknown as { send: (s: string) => void }).send = (s: string) => ws.sent.push(JSON.parse(s));
  return ws;
}
const revealsTo = (ws: ReturnType<typeof fakeSocket>) => ws.sent.filter((e) => e.type === "room:question_revealed").length;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("reveal notifications", () => {
  it("are sent once per reveal whether the bus, the reconciler or both report it", async () => {
    const { sub, publish } = fakeSub();
    const hub = new RoomEventHub(sub, { onRoomClosed: () => {} });
    const ws = fakeSocket();
    hub.add("room-1", ws as unknown as WebSocket, "candidate");

    hub.markRevealed("room-1", 1); // reconciler's first read: always announced (see markRevealed)
    expect(revealsTo(ws)).toBe(1);
    hub.markRevealed("room-1", 1); // nothing new
    expect(revealsTo(ws)).toBe(1);

    publish({ type: "room:question_revealed", roomId: "room-1", revealedCount: 2 }); // fast path
    await flush();
    expect(revealsTo(ws)).toBe(2);
    hub.markRevealed("room-1", 2); // reconciler sees the same reveal afterwards
    expect(revealsTo(ws)).toBe(2);

    hub.markRevealed("room-1", 3); // publish lost: the reconciler alone delivers it
    expect(revealsTo(ws)).toBe(3);
    publish({ type: "room:question_revealed", roomId: "room-1", revealedCount: 3 }); // late duplicate
    await flush();
    expect(revealsTo(ws)).toBe(3);
  });

  it("the reconciler reports revealed counts from the database for rooms being served", async () => {
    const counts = [{ roomId: "room-1", revealed: 2, totalRevision: 3 }];
    const chain = { from: () => chain, where: () => chain, groupBy: async () => counts };
    const db = { select: () => chain } as unknown as Parameters<typeof startRoomStatusReconciler>[0]["db"];
    const onRevealed = vi.fn();
    const onTestsAdded = vi.fn();
    const reconciler = startRoomStatusReconciler({
      db,
      intervalMs: 60_000,
      candidates: () => [],
      onClosed: () => {},
      revealCandidates: () => ["room-1"],
      onRevealed,
      onTestsAdded,
    });
    await reconciler.tick();
    reconciler.stop();
    expect(onRevealed).toHaveBeenCalledWith("room-1", 2);
    expect(onTestsAdded).toHaveBeenCalledWith("room-1", 3);
  });

  it("announces room test updates once without forwarding any case content", async () => {
    const { sub, publish } = fakeSub();
    const hub = new RoomEventHub(sub, { onRoomClosed: () => {} });
    const ws = fakeSocket();
    hub.add("room-1", ws as unknown as WebSocket, "candidate");
    publish({ type: "room:tests_added", roomId: "room-1", totalRevision: 1 });
    await flush();
    hub.markTestsAdded("room-1", 1);
    hub.markTestsAdded("room-1", 2); // the reconciler learns of a missed publish
    expect(ws.sent.filter((event) => event.type === "room:tests_added")).toEqual([
      { type: "room:tests_added", roomId: "room-1" },
      { type: "room:tests_added", roomId: "room-1" },
    ]);
  });
});
