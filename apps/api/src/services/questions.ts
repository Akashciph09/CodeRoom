import {
  and,
  asc,
  desc,
  eq,
  isNull,
  or,
  questions,
  questionVersions,
  rooms,
  sql,
  testCases,
  type Db,
} from "@coderoom/db";
import type {
  CandidateQuestionView,
  MyQuestionSummary,
  PublishProblem,
  QuestionDetail,
  QuestionDraftInput,
  QuestionSummary,
  QuestionVersionView,
  StarterCode,
} from "@coderoom/shared";
import { db } from "../db.js";
import { HttpError, NotFound } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Version = typeof questionVersions.$inferSelect;

/**
 * Optimistic-concurrency failure: the draft changed (another tab saved, published or discarded it)
 * since the client loaded the revision it's acting on. Nothing was written.
 */
export class DraftChanged extends HttpError {
  constructor(currentRevision: number | null) {
    super(
      409,
      currentRevision === null
        ? "This draft was published or discarded elsewhere. Reload to continue."
        : "This draft was changed elsewhere (another tab or window). Reload to get the latest version.",
      { conflict: "draft_changed", currentRevision },
    );
  }
}

export class PublishBlocked extends HttpError {
  constructor(public readonly problems: PublishProblem[]) {
    super(400, `Question isn't ready: ${problems.join(", ")}`, { problems });
  }
}

/** Why a draft can't be marked ready (empty = it can). Pure, so it's unit-tested directly. */
export function publishProblems(content: {
  title: string;
  statement: string;
  tests: { expectedOutput: string; isHidden: boolean }[];
}): PublishProblem[] {
  const problems: PublishProblem[] = [];
  if (!content.title.trim()) problems.push("missing_title");
  if (!content.statement.trim()) problems.push("missing_statement");
  if (content.tests.length === 0) problems.push("no_tests");
  else if (!content.tests.some((t) => !t.isHidden)) problems.push("no_public_tests");
  if (content.tests.some((t) => t.expectedOutput.trim() === "")) problems.push("empty_expected_output");
  return problems;
}

// --- Ownership --------------------------------------------------------------------------------------

/** 404 (not 403) for someone else's question, so question ids can't be probed. */
export async function requireOwnedQuestion(questionId: string, userId: string) {
  const [row] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.createdBy, userId)))
    .limit(1);
  if (!row) throw new NotFound("Question not found");
}

// --- Reads ------------------------------------------------------------------------------------------

async function testsOf(versionId: string, conn: Db | Tx = db) {
  return conn.select().from(testCases).where(eq(testCases.versionId, versionId)).orderBy(asc(testCases.position));
}

async function versionView(v: Version, conn: Db | Tx = db): Promise<QuestionVersionView> {
  const tests = await testsOf(v.id, conn);
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    title: v.title,
    statement: v.statement,
    constraints: v.constraints,
    starterCode: v.starterCode as StarterCode,
    tests: tests.map((t) => ({
      id: t.id,
      position: t.position,
      input: t.input,
      expectedOutput: t.expectedOutput,
      isHidden: t.isHidden,
    })),
    publishedAt: v.publishedAt?.toISOString() ?? null,
    updatedAt: v.updatedAt.toISOString(),
    revision: v.revision,
  };
}

const draftOf = (questionId: string, conn: Db | Tx = db) =>
  conn
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.status, "draft")))
    .limit(1)
    .then((r) => r[0] ?? null);

export const latestPublished = (questionId: string, conn: Db | Tx = db) =>
  conn
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.status, "published")))
    .orderBy(desc(questionVersions.version))
    .limit(1)
    .then((r) => r[0] ?? null);

export async function questionDetail(questionId: string, conn: Db | Tx = db): Promise<QuestionDetail> {
  const [draft, latest, versions, [usage]] = await Promise.all([
    draftOf(questionId, conn),
    latestPublished(questionId, conn),
    conn
      .select({ id: questionVersions.id, version: questionVersions.version, publishedAt: questionVersions.publishedAt })
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.status, "published")))
      .orderBy(desc(questionVersions.version)),
    conn
      .select({ n: sql<number>`count(*)::int` })
      .from(rooms)
      .innerJoin(questionVersions, eq(questionVersions.id, rooms.questionVersionId))
      .where(eq(questionVersions.questionId, questionId)),
  ]);
  return {
    id: questionId,
    draft: draft ? await versionView(draft, conn) : null,
    latest: latest ? await versionView(latest, conn) : null,
    versions: versions.map((v) => ({ id: v.id, version: v.version!, publishedAt: v.publishedAt!.toISOString() })),
    roomCount: usage?.n ?? 0,
  };
}

export async function myQuestions(userId: string): Promise<MyQuestionSummary[]> {
  const rows = await db
    .select({
      id: questions.id,
      status: questionVersions.status,
      version: questionVersions.version,
      title: questionVersions.title,
      updatedAt: questionVersions.updatedAt,
    })
    .from(questions)
    .innerJoin(questionVersions, eq(questionVersions.questionId, questions.id))
    .where(eq(questions.createdBy, userId));

  const byQuestion = new Map<string, typeof rows>();
  for (const r of rows) byQuestion.set(r.id, [...(byQuestion.get(r.id) ?? []), r]);

  return [...byQuestion.entries()]
    .map(([id, versions]) => {
      const draft = versions.find((v) => v.status === "draft");
      const published = versions
        .filter((v) => v.status === "published")
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
      const current = draft ?? published!;
      const updatedAt = versions.reduce((t, v) => (v.updatedAt > t ? v.updatedAt : t), current.updatedAt);
      return {
        id,
        title: current.title,
        status: published ? ("ready" as const) : ("draft" as const),
        latestVersion: published?.version ?? null,
        hasUnpublishedChanges: Boolean(draft && published),
        updatedAt: updatedAt.toISOString(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Questions the caller may open a room with: their own ready questions + shared library questions. */
export async function usableQuestions(userId: string): Promise<QuestionSummary[]> {
  const rows = await db
    .selectDistinctOn([questions.id], {
      id: questions.id,
      owner: questions.createdBy,
      title: questionVersions.title,
      version: questionVersions.version,
    })
    .from(questions)
    .innerJoin(questionVersions, eq(questionVersions.questionId, questions.id))
    .where(
      and(eq(questionVersions.status, "published"), or(eq(questions.createdBy, userId), isNull(questions.createdBy))),
    )
    .orderBy(questions.id, desc(questionVersions.version));
  return rows
    .map((r) => ({ id: r.id, title: r.title, version: r.version!, owned: r.owner === userId }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || a.title.localeCompare(b.title));
}

/**
 * The candidate's view of one version: public tests only, filtered in SQL so hidden tests never enter
 * this response path. Rooms and the owner's preview both use this, so the preview can't drift.
 */
export async function candidateView(versionId: string): Promise<CandidateQuestionView> {
  const [v] = await db.select().from(questionVersions).where(eq(questionVersions.id, versionId)).limit(1);
  if (!v) throw new NotFound("Question version not found");
  const [publicTests, [hidden]] = await Promise.all([
    db
      .select({ id: testCases.id, input: testCases.input, expectedOutput: testCases.expectedOutput })
      .from(testCases)
      .where(and(eq(testCases.versionId, versionId), eq(testCases.isHidden, false)))
      .orderBy(asc(testCases.position)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(testCases)
      .where(and(eq(testCases.versionId, versionId), eq(testCases.isHidden, true))),
  ]);
  return {
    id: v.questionId,
    versionId: v.id,
    version: v.version,
    title: v.title,
    statement: v.statement,
    constraints: v.constraints,
    starterCode: v.starterCode as StarterCode,
    publicTests,
    hiddenTestCount: hidden?.n ?? 0,
  };
}

// --- Writes -----------------------------------------------------------------------------------------

/** Serialize all writes to one question (draft creation, saves, publish) across API instances. */
async function lockQuestion(tx: Tx, questionId: string) {
  await tx.select({ id: questions.id }).from(questions).where(eq(questions.id, questionId)).for("update");
}

async function replaceTests(tx: Tx, versionId: string, tests: QuestionDraftInput["tests"]) {
  await tx.delete(testCases).where(eq(testCases.versionId, versionId));
  if (tests.length === 0) return;
  await tx.insert(testCases).values(
    tests.map((t, i) => ({
      versionId,
      position: i + 1,
      input: t.input,
      expectedOutput: t.expectedOutput,
      isHidden: t.isHidden,
    })),
  );
}

export async function createQuestion(userId: string, title: string): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    const [q] = await tx.insert(questions).values({ createdBy: userId }).returning({ id: questions.id });
    await tx.insert(questionVersions).values({ questionId: q!.id, status: "draft", title, statement: "" });
    return questionDetail(q!.id, tx);
  });
}

/**
 * Save the whole draft. If the question has no draft (it's ready and this is the first edit since),
 * a new draft is created — the published versions, and every room using them, are untouched.
 *
 * Optimistic concurrency: `input.baseRevision` must match the draft's current revision (or be null when
 * there is no draft). Checked under the question lock, so two tabs can't both "win" — the stale one
 * gets 409 and nothing is overwritten.
 */
export async function saveDraft(questionId: string, input: QuestionDraftInput): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    await lockQuestion(tx, questionId);
    const content = {
      title: input.title,
      statement: input.statement,
      constraints: input.constraints,
      starterCode: input.starterCode,
    };
    let draft = await draftOf(questionId, tx);
    const current = draft?.revision ?? null;
    if (input.baseRevision !== current) throw new DraftChanged(current);
    if (draft) {
      await tx
        .update(questionVersions)
        .set({ ...content, revision: sql`${questionVersions.revision} + 1` })
        .where(eq(questionVersions.id, draft.id));
    } else {
      const [created] = await tx
        .insert(questionVersions)
        .values({ questionId, status: "draft", ...content })
        .returning();
      draft = created!;
    }
    await replaceTests(tx, draft.id, input.tests);
    await tx.update(questions).set({ updatedAt: new Date() }).where(eq(questions.id, questionId));
    return questionDetail(questionId, tx);
  });
}

/**
 * Mark the draft ready: it becomes the next immutable version. Rooms created from now on use it.
 * `revision` must be the draft the author reviewed — never publish content they haven't seen.
 */
export async function publishDraft(questionId: string, revision: number): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    await lockQuestion(tx, questionId);
    const draft = await draftOf(questionId, tx);
    if (!draft || draft.revision !== revision) throw new DraftChanged(draft?.revision ?? null);
    const tests = await testsOf(draft.id, tx);
    const problems = publishProblems({ title: draft.title, statement: draft.statement, tests });
    if (problems.length > 0) throw new PublishBlocked(problems);

    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${questionVersions.version}), 0)::int + 1` })
      .from(questionVersions)
      .where(eq(questionVersions.questionId, questionId))) as [{ next: number }];
    await tx
      .update(questionVersions)
      .set({ status: "published", version: next, publishedAt: new Date() })
      .where(eq(questionVersions.id, draft.id));
    return questionDetail(questionId, tx);
  });
}

/** Throw away unpublished changes. Only when there's a ready version to fall back to. */
export async function discardDraft(questionId: string, revision: number): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    await lockQuestion(tx, questionId);
    const draft = await draftOf(questionId, tx);
    if (!draft || draft.revision !== revision) throw new DraftChanged(draft?.revision ?? null);
    if (!(await latestPublished(questionId, tx))) {
      throw new HttpError(409, "This question has never been marked ready; delete it instead");
    }
    await tx
      .delete(questionVersions)
      .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.status, "draft")));
    return questionDetail(questionId, tx);
  });
}

/** Delete a question that was never marked ready (ready versions may be pinned by rooms). */
export async function deleteQuestion(questionId: string) {
  await db.transaction(async (tx) => {
    await lockQuestion(tx, questionId);
    if (await latestPublished(questionId, tx)) {
      throw new HttpError(409, "Ready questions can't be deleted: interviews may be using them");
    }
    await tx.delete(questions).where(eq(questions.id, questionId));
  });
}
