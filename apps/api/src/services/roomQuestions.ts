import { and, asc, eq, isNotNull, roomQuestions, rooms, sql } from "@coderoom/db";
import type { Role, RoomQuestionView } from "@coderoom/shared";
import { db } from "../db.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { candidateView } from "./questions.js";

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
 * Reveal one question to the candidate. Questions are revealed strictly in order: the UPDATE only
 * matches if this question is still hidden AND the previous position is revealed, so a double-click
 * can't skip ahead. Revealing an already-revealed question is a no-op (returns false).
 */
export async function revealQuestion(roomId: string, roomQuestionId: string): Promise<boolean> {
  const [room] = await db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw new NotFound();
  if (room.status !== "open") throw new BadRequest("Room is closed");

  const updated = await db
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
  if (updated.length > 0) return true;

  const [rq] = await db
    .select({ revealedAt: roomQuestions.revealedAt })
    .from(roomQuestions)
    .where(and(eq(roomQuestions.id, roomQuestionId), eq(roomQuestions.roomId, roomId)))
    .limit(1);
  if (!rq) throw new NotFound("Question not found in this room");
  if (rq.revealedAt) return false;
  throw new Conflict("Reveal the questions in order");
}

/**
 * The revealed room question a candidate may submit to, with the version to grade against.
 * Unrevealed and nonexistent questions are indistinguishable (404): the candidate can't probe them.
 */
export async function submittableQuestion(roomId: string, roomQuestionId: string) {
  const [row] = await db
    .select({ versionId: roomQuestions.questionVersionId, status: rooms.status })
    .from(roomQuestions)
    .innerJoin(rooms, eq(rooms.id, roomQuestions.roomId))
    .where(
      and(eq(roomQuestions.id, roomQuestionId), eq(roomQuestions.roomId, roomId), isNotNull(roomQuestions.revealedAt)),
    )
    .limit(1);
  if (!row) throw new NotFound("Question not found in this room");
  if (row.status !== "open") throw new BadRequest("Room is closed");
  return row;
}
