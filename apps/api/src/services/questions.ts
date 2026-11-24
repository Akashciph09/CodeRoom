import {
  and,
  asc,
  desc,
  eq,
  isNull,
  or,
  questions,
  questionVersions,
  roomQuestions,
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
  Verdict,
} from "@coderoom/shared";
import { db } from "../db.js";
import { HttpError, NotFound } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Version = typeof questionVersions.$inferSelect;

/**
 * Optimistic-concurrency failure: the question changed (another tab saved, published, discarded or
 * started a new draft) since the client loaded the revision it's acting on. Nothing was written.
 */
export class DraftChanged extends HttpError {
  constructor(currentRevision: number) {
    super(409, "This question was changed elsewhere (another tab or window). Reload to get the latest version.", {
      conflict: "draft_changed",
      currentRevision,
    });
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
      referenceVerdict: t.referenceVerdict ?? undefined,
    })),
    publishedAt: v.publishedAt?.toISOString() ?? null,
    updatedAt: v.updatedAt.toISOString(),
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
  const [[q], draft, latest, versions, [usage]] = await Promise.all([
    conn.select({ revision: questions.revision }).from(questions).where(eq(questions.id, questionId)).limit(1),
    draftOf(questionId, conn),
    latestPublished(questionId, conn),
    conn
      .select({ id: questionVersions.id, version: questionVersions.version, publishedAt: questionVersions.publishedAt })
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.status, "published")))
      .orderBy(desc(questionVersions.version)),
    conn
      .select({ n: sql<number>`count(DISTINCT ${roomQuestions.roomId})::int` })
      .from(roomQuestions)
      .innerJoin(questionVersions, eq(questionVersions.id, roomQuestions.questionVersionId))
      .where(eq(questionVersions.questionId, questionId)),
  ]);
  return {
    id: questionId,
    revision: q!.revision,
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

/**
 * Every write to a question's draft lifecycle goes through here: lock the question row (serializing
 * writers across API instances), require that the client acted on the current revision, and bump it.
 * The revision lives on the question and never resets, so "draft X replaced by a new draft Y" can't
 * look unchanged to a stale client (the ABA problem a per-draft counter has).
 */
async function claimRevision(tx: Tx, questionId: string, expected: number) {
  const [q] = await tx
    .select({ revision: questions.revision })
    .from(questions)
    .where(eq(questions.id, questionId))
    .for("update");
  if (!q) throw new NotFound("Question not found");
  if (q.revision !== expected) throw new DraftChanged(q.revision);
  await tx
    .update(questions)
    .set({ revision: sql`${questions.revision} + 1`, updatedAt: new Date() })
    .where(eq(questions.id, questionId));
}

async function replaceTests(
  tx: Tx,
  versionId: string,
  tests: (QuestionDraftInput["tests"][number] & { referenceVerdict?: Verdict | null })[],
) {
  await tx.delete(testCases).where(eq(testCases.versionId, versionId));
  if (tests.length === 0) return;
  await tx.insert(testCases).values(tests.map((test, i) => ({
    versionId,
    position: i + 1,
    ...test,
  })));
}

export async function createQuestion(
  userId: string,
  title: string,
  generated?: { content: Omit<QuestionDraftInput, "baseRevision" | "title" | "tests">; tests: QuestionDraftInput["tests"]; verdicts: Verdict[] },
): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    const [q] = await tx.insert(questions).values({ createdBy: userId }).returning({ id: questions.id });
    const [version] = await tx.insert(questionVersions)
      .values({ questionId: q!.id, status: "draft", title, statement: "", ...generated?.content })
      .returning({ id: questionVersions.id });
    if (generated) {
      await replaceTests(tx, version!.id, generated.tests.map((test, index) => ({
        ...test,
        referenceVerdict: generated.verdicts[index],
      })));
    }
    return questionDetail(q!.id, tx);
  });
}

/**
 * Save the whole draft. If the question has no draft (it's ready and this is the first edit since),
 * a new draft is created — the published versions, and every room using them, are untouched.
 *
 * Optimistic concurrency: `input.baseRevision` must be the question's current revision (see claimRevision),
 * so a stale tab gets 409 and nothing is overwritten — including when it started editing from a ready
 * version that has since been superseded.
 */
export async function saveDraft(questionId: string, input: QuestionDraftInput): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    await claimRevision(tx, questionId, input.baseRevision);
    const content = {
      title: input.title,
      statement: input.statement,
      constraints: input.constraints,
      starterCode: input.starterCode,
    };
    let draft = await draftOf(questionId, tx);
    const previousTests = draft ? await testsOf(draft.id, tx) : [];
    if (draft) {
      await tx.update(questionVersions).set(content).where(eq(questionVersions.id, draft.id));
    } else {
      const [created] = await tx
        .insert(questionVersions)
        .values({ questionId, status: "draft", ...content })
        .returning();
      draft = created!;
    }
    await replaceTests(tx, draft.id, input.tests.map((test) => ({
      ...test,
      referenceVerdict: previousTests.find((old) => old.input === test.input && old.expectedOutput === test.expectedOutput)?.referenceVerdict,
    })));
    return questionDetail(questionId, tx);
  });
}

/**
 * Mark the draft ready: it becomes the next immutable version. Rooms created from now on use it.
 * `revision` must be the question state the author reviewed — never publish content they haven't seen.
 */
export async function publishDraft(questionId: string, revision: number): Promise<QuestionDetail> {
  return db.transaction(async (tx) => {
    await claimRevision(tx, questionId, revision);
    const draft = await draftOf(questionId, tx);
    if (!draft) throw new HttpError(409, "No draft to publish — the latest version is already ready");
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
    await claimRevision(tx, questionId, revision);
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
export async function deleteQuestion(questionId: string, revision: number) {
  await db.transaction(async (tx) => {
    await claimRevision(tx, questionId, revision);
    if (await latestPublished(questionId, tx)) {
      throw new HttpError(409, "Ready questions can't be deleted: interviews may be using them");
    }
    await tx.delete(questions).where(eq(questions.id, questionId));
  });
}
