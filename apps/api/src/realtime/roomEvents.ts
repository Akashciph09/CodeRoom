import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { ROOM_EVENTS_PATTERN, RoomBusEvent, type Role, type ServerEvent } from "@coderoom/shared";
import { loadSubmissionWithResults, viewFor } from "../services/submissionViews.js";

interface Subscriber {
  ws: WebSocket;
  role: Role;
}

/**
 * Relays room events (published by the API and worker on Redis) to this instance's event sockets.
 * Bus events carry ids only; each recipient gets the view its role allows (candidate vs interviewer).
 */
export class RoomEventHub {
  private readonly rooms = new Map<string, Set<Subscriber>>();

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
    let set = this.rooms.get(roomId);
    if (!set) this.rooms.set(roomId, (set = new Set()));
    set.add(subscriber);
    ws.on("close", () => {
      set.delete(subscriber);
      if (set.size === 0) this.rooms.delete(roomId);
    });
    // Clients only listen on this socket; ignore anything they send.
    ws.on("message", () => {});
    sendEvent(ws, { type: "ready", roomId });
  }

  private async onBusEvent(raw: string) {
    const parsed = RoomBusEvent.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const event = parsed.data;
    // Applies to this instance's editor docs even if nobody here has an events socket open.
    if (event.type === "room:closed") this.hooks.onRoomClosed(event.roomId);

    const subscribers = this.rooms.get(event.roomId);
    if (!subscribers || subscribers.size === 0) return;

    if (event.type === "room:closed") {
      for (const s of subscribers) sendEvent(s.ws, { type: "room:closed", roomId: event.roomId });
      return;
    }

    if (event.type === "submission:queued") {
      for (const s of subscribers) {
        sendEvent(s.ws, { type: "submission:queued", roomId: event.roomId, submissionId: event.submissionId });
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
