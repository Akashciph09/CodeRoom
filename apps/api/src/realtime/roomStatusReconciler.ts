import { and, inArray, ne, roomQuestions, rooms, sql, type Db } from "@coderoom/db";

/**
 * Durable delivery of room state changes. The `room:closed` and `room:question_revealed` pub/sub
 * events are the fast path, but pub/sub is fire-and-forget: the publish can fail after the DB update,
 * or a gateway can miss it (reconnecting subscriber, restart). The database is the source of truth, so
 * every gateway periodically re-reads, for the rooms it is serving:
 *  - the status — an ended room becomes read-only on every instance within one interval;
 *  - how many questions are revealed — a reveal reaches connected clients within one interval.
 */
export function startRoomStatusReconciler(opts: {
  db: Db;
  intervalMs: number;
  /** Rooms this instance serves that it still treats as open. */
  candidates: () => string[];
  onClosed: (roomId: string) => void;
  /** Rooms with event listeners here, whose revealed questions are re-read. */
  revealCandidates?: () => string[];
  onRevealed?: (roomId: string, revealedCount: number) => void;
}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const ids = [...new Set(opts.candidates())];
      if (ids.length > 0) {
        const closed = await opts.db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(inArray(rooms.id, ids), ne(rooms.status, "open")));
        for (const { id } of closed) opts.onClosed(id);
      }

      const revealIds = [...new Set(opts.revealCandidates?.() ?? [])];
      if (revealIds.length > 0 && opts.onRevealed) {
        const counts = await opts.db
          .select({
            roomId: roomQuestions.roomId,
            revealed: sql<number>`count(${roomQuestions.revealedAt})::int`,
          })
          .from(roomQuestions)
          .where(inArray(roomQuestions.roomId, revealIds))
          .groupBy(roomQuestions.roomId);
        for (const { roomId, revealed } of counts) opts.onRevealed(roomId, revealed);
      }
    } catch (err) {
      console.error("room status reconcile failed:", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
