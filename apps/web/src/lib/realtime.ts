import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { REALTIME_PROTOCOL, type Language, type ServerEvent } from "@coderoom/shared";
import { auth, getAccessToken } from "./auth";
import { WS_URL } from "./config";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface RoomUser {
  name: string;
  color: string;
  role: "interviewer" | "candidate";
}

const COLORS = ["#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#eab308", "#14b8a6"];
export const colorFor = (seed: string) =>
  COLORS[[...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;

/**
 * Shared editor state for a room:
 *  - `text`  the code ("code" Y.Text — the name the gateway and tests use)
 *  - `meta`  room-wide settings such as the selected language
 * The token goes in the WebSocket subprotocol list, never the URL. When Supabase refreshes the
 * token we swap it in, so the provider's automatic reconnect (e.g. after a 4401 close) uses the new one.
 */
export function connectRoomDoc(roomId: string, token: string, user: RoomUser) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${WS_URL}/yjs`, roomId, doc, {
    protocols: [REALTIME_PROTOCOL, token],
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", user);

  const { data } = auth.onAuthStateChange((_event, session) => {
    if (session) provider.protocols = [REALTIME_PROTOCOL, session.access_token];
  });

  return {
    doc,
    provider,
    text: doc.getText("code"),
    meta: doc.getMap<unknown>("meta"),
    destroy() {
      data.subscription.unsubscribe();
      provider.destroy();
      doc.destroy();
    },
  };
}

export type RoomDoc = ReturnType<typeof connectRoomDoc>;

export const getLanguage = (meta: Y.Map<unknown>): Language =>
  meta.get("language") === "javascript" ? "javascript" : "python";

/** Server → client room events, with reconnect (fresh token each attempt). */
export function connectRoomEvents(
  roomId: string,
  onEvent: (event: ServerEvent) => void,
  onStatus: (status: ConnectionStatus) => void,
) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = async () => {
    if (closed) return;
    onStatus("connecting");
    let token: string;
    try {
      token = await getAccessToken();
    } catch {
      onStatus("disconnected");
      return;
    }
    ws = new WebSocket(`${WS_URL}/rooms/${roomId}/events`, [REALTIME_PROTOCOL, token]);
    ws.onopen = () => {
      attempt = 0;
      onStatus("connected");
    };
    ws.onmessage = (msg) => onEvent(JSON.parse(String(msg.data)) as ServerEvent);
    ws.onclose = () => {
      onStatus("disconnected");
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };
  void open();

  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
