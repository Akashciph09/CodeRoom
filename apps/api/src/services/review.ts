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
import type { RoomCandidateSummary, RoomReview } from "@coderoom/shared";
import { db } from "../db.js";
import { NotFound } from "../errors.js";
import { revealWindows, scoreCandidate } from "./scoring.js";

/** Candidates of these rooms with display name and email (Supabase keeps the name in user metadata). */
async function candidatesOf(roomIds: string[]) {
  if (roomIds.length === 0) return [];
  return db
    .select({
      roomId: roomParticipants.roomId,
      userId: roomParticipants.userId,
      name: sql<string>`coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(u.email, '@', 1), 'Candidate')`,
      email: sql<string>`coalesce(u.email, '')`,
    })
    .from(roomParticipants)
    .innerJoin(sql`auth.users u`, sql`u.id = ${roomParticipants.userId}`)
    .where(and(inArray(roomParticipants.roomId, roomIds), eq(roomParticipants.role, "candidate")))
    .orderBy(asc(roomParticipants.joinedAt));
}

/** Per-submission test counts (hidden included — interviewer-only callers). */
async function passCounts(submissionIds: string[]) {
  if (submissionIds.length === 0) return new Map<string, { passed: number; total: number; hiddenPassed: number; hiddenTotal: number }>();
  const rows = await db
    .select({
      submissionId: testResults.submissionId,
      passed: sql<number>`count(*) filter (where ${testResults.verdict} = 'accepted')::int`,
      total: sql<number>`count(*)::int`,
      hiddenPassed: sql<number>`count(*) filter (where ${testResults.isHidden} and ${testResults.verdict} = 'accepted')::int`,
      hiddenTotal: sql<number>`count(*) filter (where ${testResults.isHidden})::int`,
    })
    .from(testResults)
    .where(inArray(testResults.submissionId, submissionIds))
    .groupBy(testResults.submissionId);
  return new Map(rows.map((r) => [r.submissionId, r]));
}

/**
 * For the interviewer's room list: each room's candidates with name, email and test score — computed by
 * the same `scoreCandidate` as the review page, so the two always agree. Batched for all rooms at once.
 * Interviewer rooms only: the caller must pass only rooms where the user is the interviewer.
 */
export async function candidateSummaries(roomIds: string[]): Promise<Map<string, RoomCandidateSummary[]>> {
  const out = new Map<string, RoomCandidateSummary[]>(roomIds.map((id) => [id, []]));
  if (roomIds.length === 0) return out;
  const [qs, people, subs] = await Promise.all([
    db
      .select({ roomId: roomQuestions.roomId, id: roomQuestions.id, points: roomQuestions.points, revealedAt: roomQuestions.revealedAt })
      .from(roomQuestions)
      .where(inArray(roomQuestions.roomId, roomIds)),
    candidatesOf(roomIds),
    // Only completed Submits can score (scoreCandidate ignores the rest anyway).
    db
      .select({
        id: submissions.id,
        roomId: submissions.roomId,
        userId: submissions.userId,
        roomQuestionId: submissions.roomQuestionId,
        mode: submissions.mode,
        status: submissions.status,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .where(and(inArray(submissions.roomId, roomIds), eq(submissions.mode, "submit"), eq(submissions.status, "completed"))),
  ]);
  const counts = await passCounts(subs.map((s) => s.id));
  for (const person of people) {
    const mine = subs.filter((s) => s.roomId === person.roomId && s.userId === person.userId);
    const { score } = scoreCandidate(
      qs.filter((q) => q.roomId === person.roomId).map((q) => ({ id: q.id, points: q.points, revealed: q.revealedAt !== null })),
      mine.map((s) => ({ ...s, passed: counts.get(s.id)?.passed ?? 0, total: counts.get(s.id)?.total ?? 0 })),
    );
    out.get(person.roomId)!.push({ name: person.name, email: person.email, score, hasSubmit: mine.length > 0 });
  }
  return out;
}

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
  const windows = revealWindows(qs, room.closedAt ?? now);

  const candidates = await candidatesOf([roomId]);

  const subs = await db
    .select()
    .from(submissions)
    .where(eq(submissions.roomId, roomId))
    .orderBy(asc(submissions.createdAt));

  const countOf = await passCounts(subs.map((s) => s.id));

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
      ...(windows.has(q.id) ? { revealWindowMs: windows.get(q.id)! } : {}),
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
