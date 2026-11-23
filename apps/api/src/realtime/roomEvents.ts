import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { ROOM_EVENTS_PATTERN, RoomBusEvent, type Role, type ServerEvent } from "@coderoom/shared";
import { loadSubmissionWithResults, viewFor } from "../services/submissionViews.js";

interface Subscriber {
  ws: WebSocket;
  role: Role;
}

interface RoomSubscribers {
  subs: Set<Subscriber>;
  /** `room:closed` already sent to this room's sockets on this instance. */
  closed: boolean;
  /** Highest revealed-question count this instance has announced to the room (undefined = none yet). */
  revealed?: number;
}

/**
 * Relays room events (published by the API and worker on Redis) to this instance's event sockets.
 * Bus events carry ids only; each recipient gets the view its role allows (candidate vs interviewer).
 */
export class RoomEventHub {
  private readonly rooms = new Map<string, RoomSubscribers>();

  constructor(
    sub: Redis,
    private readonly hooks: { onRoomClosed: (roomId: string) => void },
  ) {
    sub.on("pmessage", (_pattern: string, _channel: string, message: string) => {
      this.onBusEvent(message).catch((err) => console.error("room event relay failed:", err));
    });
    sub.psubscribe(ROOM_EVENTS_PATTERN).catch((err) => console.error("psubscribe failed:", err));
  }

  add(roomId: string, ws: WebSocket, role: Role) {
    const subscriber: Subscriber = { ws, role };
    let room = this.rooms.get(roomId);
    if (!room) this.rooms.set(roomId, (room = { subs: new Set(), closed: false }));
    room.subs.add(subscriber);
    ws.on("close", () => {
      room.subs.delete(subscriber);
      if (room.subs.size === 0 && this.rooms.get(roomId) === room) this.rooms.delete(roomId);
    });
    // Clients only listen on this socket; ignore anything they send.
    ws.on("message", () => {});
    sendEvent(ws, { type: "ready", roomId });
  }

  /**
   * The room has `count` revealed questions — learned from the bus (fast path) or the database
   * (reconciler). Sockets get `room:question_revealed` (they re-fetch the room) only when the count
   * goes up, so a reveal is announced once even though both paths report it.
   *
   * The first count seen for a room is always announced: it may include a reveal that happened after a
   * client's on-connect fetch but before this instance started tracking the room. A spare re-fetch is
   * harmless (the client merges forward-only); a missed reveal would leave the candidate stuck.
   */
  markRevealed(roomId: string, count: number) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.revealed !== undefined && count <= room.revealed) return;
    room.revealed = count;
    for (const s of room.subs) sendEvent(s.ws, { type: "room:question_revealed", roomId });
  }

  /** Rooms with listeners here that haven't been told the room ended (checked by the status reconciler). */
  openRoomIds(): string[] {
    return [...this.rooms.entries()].filter(([, r]) => !r.closed).map(([id]) => id);
  }

  /**
   * The room ended — learned from the bus (fast path) or from the database (reconciler). Idempotent:
   * docs become read-only and each local events socket gets `room:closed` once.
   */
  markClosed(roomId: string) {
    this.hooks.onRoomClosed(roomId);
    const room = this.rooms.get(roomId);
    if (!room || room.closed) return;
    room.closed = true;
    for (const s of room.subs) sendEvent(s.ws, { type: "room:closed", roomId });
  }

  private async onBusEvent(raw: string) {
    const parsed = RoomBusEvent.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "room:closed") return this.markClosed(event.roomId);

    const subscribers = this.rooms.get(event.roomId)?.subs;
    if (!subscribers || subscribers.size === 0) return;

    // Id-only: no question content goes over the socket; each client re-fetches its own role's view.
    if (event.type === "room:question_revealed") return this.markRevealed(event.roomId, event.revealedCount);

    if (event.type === "submission:queued") {
      for (const s of subscribers) {
        sendEvent(s.ws, {
          type: "submission:queued",
          roomId: event.roomId,
          submissionId: event.submissionId,
          ...(event.roomQuestionId ? { roomQuestionId: event.roomQuestionId } : {}),
        });
      }
      return;
    }

    const loaded = await loadSubmissionWithResults(event.submissionId);
    if (!loaded || loaded.submission.roomId !== event.roomId) return;
    for (const s of subscribers) {
      sendEvent(s.ws, { type: "submission:result", roomId: event.roomId, result: viewFor(s.role, loaded) });
    }
  }
}

function sendEvent(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === 1) ws.send(JSON.stringify(event));
}
