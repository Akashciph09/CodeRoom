import { and, asc, eq, isNotNull, roomQuestions, rooms, sql, type Db } from "@coderoom/db";
import type { Role, RoomQuestionView } from "@coderoom/shared";
import { db } from "../db.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { candidateView } from "./questions.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A room's questions as `role` may see them (ADR 0009). Candidates get only revealed questions — the
 * filter is in SQL, so an unrevealed question's content is never even loaded for a candidate request.
 */
export async function roomQuestionsFor(roomId: string, role: Role): Promise<RoomQuestionView[]> {
  const rows = await db
    .select({
      id: roomQuestions.id,
      position: roomQuestions.position,
      versionId: roomQuestions.questionVersionId,
      revealedAt: roomQuestions.revealedAt,
    })
    .from(roomQuestions)
    .where(
      role === "interviewer"
        ? eq(roomQuestions.roomId, roomId)
        : and(eq(roomQuestions.roomId, roomId), isNotNull(roomQuestions.revealedAt)),
    )
    .orderBy(asc(roomQuestions.position));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      position: r.position,
      revealed: r.revealedAt !== null,
      question: await candidateView(r.versionId),
    })),
  );
}

/**
 * Reveal one question to the candidate.
 *  - Strictly in order: the UPDATE only matches if this question is still hidden AND the previous
 *    position is revealed, so a double-click can't skip ahead. Repeating a reveal is a no-op.
 *  - Never after the session ended: the room row is locked (`FOR UPDATE`) and its status checked in
 *    the same transaction as the UPDATE. Ending a session is an UPDATE of that row, so it takes the
 *    same lock: whichever comes second waits for the first to commit and then sees its result.
 * Returns whether this call revealed it, and how many questions are revealed now (for the bus event).
 */
export async function revealQuestion(
  roomId: string,
  roomQuestionId: string,
): Promise<{ changed: boolean; revealedCount: number }> {
  return db.transaction(async (tx) => {
    const [room] = await tx.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId)).for("update");
    if (!room) throw new NotFound();
    if (room.status !== "open") throw new BadRequest("Room is closed");

    const updated = await tx
      .update(roomQuestions)
      .set({ revealedAt: new Date() })
      .where(
        and(
          eq(roomQuestions.id, roomQuestionId),
          eq(roomQuestions.roomId, roomId),
          sql`${roomQuestions.revealedAt} IS NULL`,
          sql`EXISTS (SELECT 1 FROM ${roomQuestions} prev
                      WHERE prev.room_id = ${roomId}
                        AND prev.position = ${roomQuestions.position} - 1
                        AND prev.revealed_at IS NOT NULL)`,
        ),
      )
      .returning({ id: roomQuestions.id });

    if (updated.length === 0) {
      const [rq] = await tx
        .select({ revealedAt: roomQuestions.revealedAt })
        .from(roomQuestions)
        .where(and(eq(roomQuestions.id, roomQuestionId), eq(roomQuestions.roomId, roomId)))
        .limit(1);
      if (!rq) throw new NotFound("Question not found in this room");
      if (!rq.revealedAt) throw new Conflict("Reveal the questions in order");
    }
    const [counted] = await tx
      .select({ n: sql<number>`count(${roomQuestions.revealedAt})::int` })
      .from(roomQuestions)
      .where(eq(roomQuestions.roomId, roomId));
    return { changed: updated.length > 0, revealedCount: counted!.n };
  });
}

/**
 * The revealed room question a candidate may submit to, with the version to grade against.
 * Unrevealed and nonexistent questions are indistinguishable (404): the candidate can't probe them.
 *
 * Must run inside the transaction that inserts the submission: it takes a SHARE lock on the room row,
 * which concurrent submissions can all hold at once but which conflicts with the row lock that ending
 * the session (an UPDATE of that row) needs. So a submission either commits before the room is closed
 * or waits for the close and is then refused — never accepted into an ended room.
 */
export async function submittableQuestion(tx: Tx, roomId: string, roomQuestionId: string) {
  const [row] = await tx
    .select({ versionId: roomQuestions.questionVersionId, status: rooms.status })
    .from(roomQuestions)
    .innerJoin(rooms, eq(rooms.id, roomQuestions.roomId))
    .where(
      and(eq(roomQuestions.id, roomQuestionId), eq(roomQuestions.roomId, roomId), isNotNull(roomQuestions.revealedAt)),
    )
    .limit(1)
    .for("share", { of: rooms });
  if (!row) throw new NotFound("Question not found in this room");
  if (row.status !== "open") throw new BadRequest("Room is closed");
  return row;
}
