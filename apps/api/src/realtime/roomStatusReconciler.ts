import { and, inArray, ne, rooms, type Db } from "@coderoom/db";

/**
 * Durable enforcement of room closure. The `room:closed` pub/sub event is the fast path, but
 * pub/sub is fire-and-forget: the publish can fail after the DB update, or a gateway can miss it
 * (reconnecting subscriber, restart). The database is the source of truth, so every gateway
 * periodically re-reads the status of the rooms it is serving and enforces it.
 *
 * Bound: an ended room becomes read-only on every instance within one interval, even with no pub/sub.
 */
export function startRoomStatusReconciler(opts: {
  db: Db;
  intervalMs: number;
  /** Rooms this instance serves that it still treats as open. */
  candidates: () => string[];
  onClosed: (roomId: string) => void;
}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const ids = [...new Set(opts.candidates())];
      if (ids.length === 0) return;
      const closed = await opts.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(inArray(rooms.id, ids), ne(rooms.status, "open")));
      for (const { id } of closed) opts.onClosed(id);
    } catch (err) {
      console.error("room status reconcile failed:", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
