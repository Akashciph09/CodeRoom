import {
  and,
  asc,
  eq,
  evaluationEvidence,
  evaluations,
  evaluationScores,
  inArray,
  interviewNotes,
  roomParticipants,
  rooms,
  sql,
  submissions,
} from "@coderoom/db";
import {
  evaluationProblems,
  RUBRIC,
  type DimensionScore,
  type EvaluationDraftInput,
  type EvaluationView,
  type RubricDimension,
} from "@coderoom/shared";
import { db } from "../db.js";
import { HttpError, NotFound } from "../errors.js";

/*
 * The interviewer's structured evaluation (ADR 0017). Callers must have checked the interviewer role.
 * Every rule here is also enforced by the database (composite FKs for evidence scope; triggers for the
 * lock, completeness and "only after the interview ended") — these checks give clear errors first.
 */

export class EvaluationChanged extends HttpError {
  constructor(currentRevision?: number) {
    super(409, "This evaluation was changed elsewhere (another tab or window). Reload to get the latest version.", {
      conflict: "evaluation_changed",
      ...(currentRevision !== undefined ? { currentRevision } : {}),
    });
  }
}
export class EvaluationLocked extends HttpError {
  constructor() {
    super(409, "This evaluation has been submitted and is locked.", { conflict: "evaluation_submitted" });
  }
}
export class RoomStillOpen extends HttpError {
  constructor() {
    super(409, "End the interview before submitting the evaluation.", { conflict: "room_open" });
  }
}
export class EvaluationIncomplete extends HttpError {
  constructor(problems: string[]) {
    super(400, `The evaluation isn't complete: ${problems.join(" ")}`, { problems });
  }
}
export class NoteCited extends HttpError {
  constructor() {
    super(409, "This note is evidence in a submitted evaluation, so it can't be changed or deleted.", { conflict: "note_cited" });
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The candidate must be this room's candidate; anything else is "not found". */
async function requireCandidate(roomId: string, candidateId: string) {
  const [p] = await db
    .select({ role: roomParticipants.role })
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, candidateId)))
    .limit(1);
  if (p?.role !== "candidate") throw new NotFound("Candidate not found in this room");
}

/** Every linked note is from this room and every run is this candidate's, in this room. */
async function checkEvidence(roomId: string, candidateId: string, dims: DimensionScore[]) {
  const noteIds = [...new Set(dims.flatMap((d) => d.evidence.flatMap((e) => ("noteId" in e ? [e.noteId] : []))))];
  const runIds = [...new Set(dims.flatMap((d) => d.evidence.flatMap((e) => ("submissionId" in e ? [e.submissionId] : []))))];
  if (noteIds.length > 0) {
    const found = await db
      .select({ id: interviewNotes.id })
      .from(interviewNotes)
      .where(and(eq(interviewNotes.roomId, roomId), inArray(interviewNotes.id, noteIds)));
    if (found.length !== noteIds.length) throw new NotFound("A linked note isn't in this room");
  }
  if (runIds.length > 0) {
    const found = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.roomId, roomId), eq(submissions.userId, candidateId), inArray(submissions.id, runIds)));
    if (found.length !== runIds.length) throw new NotFound("A linked run isn't this candidate's in this room");
  }
}

/** The evaluator's evaluations in this room, by candidate id. */
export async function evaluationsBy(roomId: string, evaluatorId: string): Promise<Map<string, EvaluationView>> {
  const rows = await db
    .select({
      e: evaluations,
      submitterName: sql<string | null>`(select coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(u.email, '@', 1)) from auth.users u where u.id = ${evaluations.submittedBy})`,
    })
    .from(evaluations)
    .where(and(eq(evaluations.roomId, roomId), eq(evaluations.evaluatorId, evaluatorId)));
  const out = new Map<string, EvaluationView>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.e.id);
  const [scores, evidence] = await Promise.all([
    db.select().from(evaluationScores).where(inArray(evaluationScores.evaluationId, ids)),
    db.select().from(evaluationEvidence).where(inArray(evaluationEvidence.evaluationId, ids)).orderBy(asc(evaluationEvidence.position)),
  ]);
  for (const { e, submitterName } of rows) {
    const dimensions: DimensionScore[] = RUBRIC.map((r) => {
      const s = scores.find((x) => x.evaluationId === e.id && x.dimension === r.dimension);
      return {
        dimension: r.dimension,
        rating: s?.rating ?? null,
        notObserved: s?.notObserved ?? false,
        explanation: s?.explanation ?? "",
        evidence: evidence
          .filter((x) => x.evaluationId === e.id && x.dimension === r.dimension)
          .map((x) => (x.noteId ? { noteId: x.noteId } : { submissionId: x.submissionId! })),
      };
    });
    out.set(e.candidateId, {
      id: e.id,
      candidateId: e.candidateId,
      status: e.status,
      revision: e.revision,
      recommendation: e.recommendation,
      summary: e.summary,
      dimensions,
      updatedAt: e.updatedAt.toISOString(),
      ...(e.submittedAt ? { submittedAt: e.submittedAt.toISOString() } : {}),
      ...(e.submittedBy ? { submittedBy: { id: e.submittedBy, name: submitterName ?? "Interviewer" } } : {}),
    });
  }
  return out;
}

async function viewOf(roomId: string, candidateId: string, evaluatorId: string): Promise<EvaluationView> {
  const view = (await evaluationsBy(roomId, evaluatorId)).get(candidateId);
  if (!view) throw new NotFound("Evaluation not found");
  return view;
}

async function writeParts(tx: Tx, evaluationId: string, roomId: string, candidateId: string, dims: DimensionScore[]) {
  // Deleting the scores cascades to their evidence; then write the whole document again.
  await tx.delete(evaluationScores).where(eq(evaluationScores.evaluationId, evaluationId));
  await tx.insert(evaluationScores).values(
    dims.map((d) => ({
      evaluationId,
      dimension: d.dimension as RubricDimension,
      rating: d.rating,
      notObserved: d.notObserved,
      explanation: d.explanation,
    })),
  );
  const evidence = dims.flatMap((d) =>
    d.evidence.map((ref, position) => ({
      evaluationId,
      roomId,
      candidateId,
      dimension: d.dimension as RubricDimension,
      position,
      noteId: "noteId" in ref ? ref.noteId : null,
      submissionId: "submissionId" in ref ? ref.submissionId : null,
    })),
  );
  if (evidence.length > 0) await tx.insert(evaluationEvidence).values(evidence);
}

/**
 * Save the whole draft. Allowed during the interview and after it; never once submitted.
 * Optimistic concurrency: `baseRevision` must be the current revision (0 = no evaluation yet), so a
 * stale tab gets 409 instead of overwriting newer work.
 */
export async function saveEvaluationDraft(
  roomId: string,
  candidateId: string,
  evaluatorId: string,
  input: EvaluationDraftInput,
): Promise<EvaluationView> {
  await requireCandidate(roomId, candidateId);
  await checkEvidence(roomId, candidateId, input.dimensions);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: evaluations.id, status: evaluations.status, revision: evaluations.revision })
      .from(evaluations)
      .where(and(eq(evaluations.roomId, roomId), eq(evaluations.candidateId, candidateId), eq(evaluations.evaluatorId, evaluatorId)))
      .for("update");
    let id: string;
    if (!current) {
      if (input.baseRevision !== 0) throw new EvaluationChanged();
      // Two tabs creating at once: the unique index lets one in; the other is told to reload.
      const [created] = await tx
        .insert(evaluations)
        .values({ roomId, candidateId, evaluatorId, recommendation: input.recommendation, summary: input.summary })
        .onConflictDoNothing()
        .returning({ id: evaluations.id });
      if (!created) throw new EvaluationChanged();
      id = created.id;
    } else {
      if (current.status === "submitted") throw new EvaluationLocked();
      if (current.revision !== input.baseRevision) throw new EvaluationChanged(current.revision);
      id = current.id;
      await tx
        .update(evaluations)
        .set({
          recommendation: input.recommendation,
          summary: input.summary,
          revision: sql`${evaluations.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(evaluations.id, id));
    }
    await writeParts(tx, id, roomId, candidateId, input.dimensions);
  });
  return viewOf(roomId, candidateId, evaluatorId);
}

/**
 * Submit and lock: only after the interview ended, only when complete, only from the latest revision.
 * Records who submitted it and when.
 */
export async function submitEvaluation(roomId: string, candidateId: string, evaluatorId: string, revision: number): Promise<EvaluationView> {
  await requireCandidate(roomId, candidateId);
  await db.transaction(async (tx) => {
    // "closed" is final, so checking it here can't race with the room reopening.
    const [room] = await tx.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId));
    if (room?.status !== "closed") throw new RoomStillOpen();
    const [current] = await tx
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.roomId, roomId), eq(evaluations.candidateId, candidateId), eq(evaluations.evaluatorId, evaluatorId)))
      .for("update");
    if (!current) throw new NotFound("Save a draft before submitting");
    if (current.status === "submitted") throw new EvaluationLocked();
    if (current.revision !== revision) throw new EvaluationChanged(current.revision);
    const scores = await tx.select().from(evaluationScores).where(eq(evaluationScores.evaluationId, current.id));
    const problems = evaluationProblems({
      recommendation: current.recommendation,
      dimensions: scores.map((s) => ({ dimension: s.dimension, rating: s.rating, notObserved: s.notObserved, explanation: "", evidence: [] })),
    });
    if (problems.length > 0) throw new EvaluationIncomplete(problems);
    await tx
      .update(evaluations)
      .set({
        status: "submitted",
        submittedAt: sql`now()`,
        submittedBy: evaluatorId,
        revision: sql`${evaluations.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(evaluations.id, current.id));
  });
  return viewOf(roomId, candidateId, evaluatorId);
}

/** Notes cited by a submitted evaluation are part of its evidence: no edits, no deletes. */
export async function assertNoteNotCited(noteId: string) {
  const [cited] = await db
    .select({ id: evaluationEvidence.id })
    .from(evaluationEvidence)
    .innerJoin(evaluations, eq(evaluations.id, evaluationEvidence.evaluationId))
    .where(and(eq(evaluationEvidence.noteId, noteId), eq(evaluations.status, "submitted")))
    .limit(1);
  if (cited) throw new NoteCited();
}
