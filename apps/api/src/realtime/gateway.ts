import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Redis } from "ioredis";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { eq, rooms } from "@coderoom/db";
import { CloseCode, REALTIME_PROTOCOL, type Role } from "@coderoom/shared";
import { getRoomRole, verifyAccessToken, type AuthUser } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { redis } from "../queue.js";
import { UuidParam } from "../routes/params.js";
import { RoomDocManager } from "./roomDocs.js";
import { RoomEventHub } from "./roomEvents.js";

type Route = { kind: "yjs" | "events"; roomId: string };

const HEARTBEAT_MS = 30_000;

/**
 * WebSocket gateway on the API's HTTP server.
 * Every connection is authenticated and authorized BEFORE the upgrade completes:
 *   token (Sec-WebSocket-Protocol) → JWT verify → room participant? → room open?
 * Rejected upgrades get a plain HTTP error and never consume a socket.
 */
export function attachRealtimeGateway(server: Server) {
  const instanceId = randomUUID();
  // A Redis connection in subscriber mode can't publish, so pub/sub get separate connections.
  const sub = new Redis(config.REDIS_URL);
  const docs = new RoomDocManager({
    db,
    pub: redis,
    sub,
    instanceId,
    persistDebounceMs: config.DOC_PERSIST_DEBOUNCE_MS,
  });
  const events = new RoomEventHub(sub);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.WS_MAX_PAYLOAD_BYTES,
    // Echo our protocol name back; the token entry is never selected.
    handleProtocols: (protocols) => (protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false),
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    authorizeUpgrade(req)
      .then((result) => {
        if ("status" in result) return reject(socket, result.status);
        wss.handleUpgrade(req, socket, head, (ws) => {
          keepAlive(ws);
          closeOnTokenExpiry(ws, result.user);
          if (result.route.kind === "events") {
            events.add(result.route.roomId, ws, result.role);
          } else {
            serveYjs(docs, result.route.roomId, ws);
          }
        });
      })
      .catch((err) => {
        console.error("upgrade failed:", err);
        reject(socket, 500);
      });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const alive = ws as WebSocket & { isAlive?: boolean };
      if (alive.isAlive === false) {
        ws.terminate();
        continue;
      }
      alive.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return {
    instanceId,
    stats: () => ({ connections: wss.clients.size, rooms: docs.roomCount }),
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
      await docs.closeAll();
      await sub.quit();
    },
  };
}

// -------------------------------------------------------------------------------------------------

async function authorizeUpgrade(
  req: IncomingMessage,
): Promise<{ status: number } | { route: Route; user: AuthUser; role: Role }> {
  const route = parseRoute(req.url ?? "");
  if (!route) return { status: 404 };

  const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  if (!protocols.includes(REALTIME_PROTOCOL)) return { status: 400 };
  const token = protocols.find((p) => p && p !== REALTIME_PROTOCOL);
  if (!token) return { status: 401 };

  let user: AuthUser;
  try {
    user = await verifyAccessToken(token);
  } catch {
    return { status: 401 };
  }

  const role = await getRoomRole(route.roomId, user.userId);
  if (!role) return { status: 403 };

  const [room] = await db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, route.roomId)).limit(1);
  if (!room || room.status !== "open") return { status: 410 };

  return { route, user, role };
}

export function parseRoute(rawUrl: string): Route | null {
  const path = new URL(rawUrl, "http://localhost").pathname;
  const yjs = /^\/yjs\/([^/]+)$/.exec(path);
  const evt = /^\/rooms\/([^/]+)\/events$/.exec(path);
  const kind = yjs ? "yjs" : evt ? "events" : null;
  const id = (yjs ?? evt)?.[1];
  if (!kind || !id || !UuidParam.safeParse(id).success) return null;
  return { kind, roomId: id };
}

function serveYjs(docs: RoomDocManager, roomId: string, ws: WebSocket) {
  ws.binaryType = "nodebuffer";
  const ready = docs.connect(roomId, ws);
  // Process messages strictly in order, after the doc is loaded.
  let queue: Promise<unknown> = ready.then((entry) => {
    if (ws.readyState !== ws.OPEN) return; // closed while loading; the close handler cleans up
    docs.greet(entry, ws);
  });

  ws.on("message", (data: RawData) => {
    queue = queue
      .then(() => ready)
      .then((entry) => docs.handleClientMessage(entry, ws, toUint8(data)))
      .catch((err) => {
        console.error(`yjs message error in room ${roomId}:`, err);
        ws.close(1003, "invalid message");
      });
  });
  ws.on("close", () => {
    // Disconnect AFTER any queued messages, so a late awareness update can't outlive the connection.
    queue = queue.then(() => ready).then(() => docs.disconnect(roomId, ws)).catch(() => {});
  });
  ready.catch((err) => {
    console.error(`could not load room ${roomId}:`, err);
    ws.close(1011, "could not load document");
  });
}

function keepAlive(ws: WebSocket) {
  const alive = ws as WebSocket & { isAlive?: boolean };
  alive.isAlive = true;
  ws.on("pong", () => (alive.isAlive = true));
}

/** Supabase tokens last ~1h. Close at expiry; the client reconnects with a refreshed token. */
function closeOnTokenExpiry(ws: WebSocket, user: AuthUser) {
  const ms = user.expiresAt * 1000 - Date.now();
  const timer = setTimeout(() => ws.close(CloseCode.Unauthorized, "token expired"), Math.max(ms, 0));
  ws.on("close", () => clearTimeout(timer));
}

function reject(socket: Duplex, status: number) {
  const text: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    410: "Gone",
    500: "Internal Server Error",
  };
  socket.end(`HTTP/1.1 ${status} ${text[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
