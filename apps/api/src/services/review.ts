import {
  and,
  asc,
  eq,
  inArray,
  questionVersions,
  roomParticipants,
  roomQuestions,
  rooms,
  sql,
  submissions,
  testResults,
} from "@coderoom/db";
import type { RoomReview } from "@coderoom/shared";
import { db } from "../db.js";
import { NotFound } from "../errors.js";
import { scoreCandidate, timePerQuestion } from "./scoring.js";

/**
 * Everything the interviewer needs to evaluate a room afterwards (ADR 0011), built from stored data:
 * pinned questions with reveal times, each candidate's runs/submissions with per-test counts and code,
 * and the test score. Interviewer only — the caller must check the role.
 */
export async function roomReview(roomId: string): Promise<RoomReview> {
  const [room] = await db
    .select({ status: rooms.status, createdAt: rooms.createdAt, closedAt: rooms.closedAt })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) throw new NotFound();
  const now = new Date();

  const qs = await db
    .select({
      id: roomQuestions.id,
      position: roomQuestions.position,
      points: roomQuestions.points,
      revealedAt: roomQuestions.revealedAt,
      title: questionVersions.title,
      version: questionVersions.version,
    })
    .from(roomQuestions)
    .innerJoin(questionVersions, eq(questionVersions.id, roomQuestions.questionVersionId))
    .where(eq(roomQuestions.roomId, roomId))
    .orderBy(asc(roomQuestions.position));
  const times = timePerQuestion(qs, room.closedAt ?? now);

  // Candidates with their display name (Supabase keeps it in user metadata; fall back to the email's name).
  const candidates = await db
    .select({
      userId: roomParticipants.userId,
      name: sql<string>`coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(u.email, '@', 1), 'Candidate')`,
    })
    .from(roomParticipants)
    .innerJoin(sql`auth.users u`, sql`u.id = ${roomParticipants.userId}`)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.role, "candidate")))
    .orderBy(asc(roomParticipants.joinedAt));

  const subs = await db
    .select()
    .from(submissions)
    .where(eq(submissions.roomId, roomId))
    .orderBy(asc(submissions.createdAt));

  // Per-submission test counts (hidden included — the interviewer sees everything).
  const counts = subs.length
    ? await db
        .select({
          submissionId: testResults.submissionId,
          passed: sql<number>`count(*) filter (where ${testResults.verdict} = 'accepted')::int`,
          total: sql<number>`count(*)::int`,
          hiddenPassed: sql<number>`count(*) filter (where ${testResults.isHidden} and ${testResults.verdict} = 'accepted')::int`,
          hiddenTotal: sql<number>`count(*) filter (where ${testResults.isHidden})::int`,
        })
        .from(testResults)
        .where(
          inArray(
            testResults.submissionId,
            subs.map((s) => s.id),
          ),
        )
        .groupBy(testResults.submissionId)
    : [];
  const countOf = new Map(counts.map((c) => [c.submissionId, c]));

  return {
    roomId,
    status: room.status,
    createdAt: room.createdAt.toISOString(),
    ...(room.closedAt ? { closedAt: room.closedAt.toISOString() } : {}),
    serverTime: now.toISOString(),
    questions: qs.map((q) => ({
      id: q.id,
      position: q.position,
      title: q.title,
      version: q.version,
      points: q.points,
      ...(q.revealedAt ? { revealedAt: q.revealedAt.toISOString() } : {}),
      ...(times.has(q.id) ? { timeSpentMs: times.get(q.id)! } : {}),
    })),
    candidates: candidates.map((c) => {
      const mine = subs
        .filter((s) => s.userId === c.userId)
        .map((s) => {
          const n = countOf.get(s.id);
          return {
            submission: s,
            passed: n?.passed ?? 0,
            total: n?.total ?? 0,
            hiddenPassed: n?.hiddenPassed ?? 0,
            hiddenTotal: n?.hiddenTotal ?? 0,
          };
        });
      const scored = scoreCandidate(
        qs.map((q) => ({ id: q.id, points: q.points, revealed: q.revealedAt !== null })),
        mine.map((m) => ({
          id: m.submission.id,
          roomQuestionId: m.submission.roomQuestionId,
          mode: m.submission.mode,
          status: m.submission.status,
          passed: m.passed,
          total: m.total,
          createdAt: m.submission.createdAt,
        })),
      );
      return {
        userId: c.userId,
        name: c.name,
        score: scored.score,
        questions: scored.questions,
        submissions: mine.map((m) => ({
          submissionId: m.submission.id,
          roomQuestionId: m.submission.roomQuestionId,
          mode: m.submission.mode,
          status: m.submission.status,
          ...(m.submission.overall ? { overall: m.submission.overall } : {}),
          language: m.submission.language,
          code: m.submission.code,
          createdAt: m.submission.createdAt.toISOString(),
          passed: m.passed,
          total: m.total,
          hiddenPassed: m.hiddenPassed,
          hiddenTotal: m.hiddenTotal,
          customCases: m.submission.customCases?.length ?? 0,
        })),
      };
    }),
  };
}
