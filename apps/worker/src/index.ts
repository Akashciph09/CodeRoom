import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { and, asc, lte, roomTestCases, roomTestResults, createDb, customCaseResults, eq, submissions, testCases, testResults, type NewTestResult } from "@coderoom/db";
import { EXECUTION_QUEUE, ExecutionJob, QUESTION_VALIDATION_JOB, QuestionValidationJob, roomEventsChannel, type RoomBusEvent } from "@coderoom/shared";
import { config } from "./config.js";
import { startOutboxSweeper } from "./outbox.js";
import { runInSandbox } from "./sandbox/runner.js";
import { judge, judgeCustom, overallVerdict } from "./sandbox/verdict.js";

const { db, close: closeDb } = createDb(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY + 2 });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(config.REDIS_URL);

/** Tell realtime gateways the submission finished; they load results and push role-specific views. */
async function finish(roomId: string, submissionId: string, status: "completed" | "failed") {
  const event: RoomBusEvent = { type: "submission:done", roomId, submissionId, status };
  await publisher.publish(roomEventsChannel(roomId), JSON.stringify(event));
}

async function validateQuestionDraft(data: unknown) {
  const { referencePython, tests, expiresAt } = QuestionValidationJob.parse(data);
  const verdicts = [];
  for (const test of tests) {
    if (Date.now() >= expiresAt) throw new UnrecoverableError("Question validation expired");
    const result = await runInSandbox({
      language: "python",
      code: referencePython,
      stdin: test.input,
      timeoutMs: config.SANDBOX_TIMEOUT_MS,
      memoryMb: config.SANDBOX_MEMORY_MB,
      cpus: config.SANDBOX_CPUS,
    });
    verdicts.push(judge(result, test.expectedOutput));
  }
  return verdicts;
}

async function processJob(job: Job) {
  if (job.name === QUESTION_VALIDATION_JOB) return validateQuestionDraft(job.data);
  const { submissionId } = ExecutionJob.parse(job.data);

  const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!submission) throw new UnrecoverableError(`Submission ${submissionId} not found`);
  // Already finished (e.g. a duplicate job after outbox recovery): never run it twice.
  if (submission.status === "completed" || submission.status === "failed") return;

  const tests = await db
    .select()
    .from(testCases)
    .where(eq(testCases.versionId, submission.questionVersionId)) // the exact version the room pinned
    .orderBy(asc(testCases.position));
  const additions = submission.roomTestRevision === 0 ? [] : await db.select().from(roomTestCases)
    .where(and(eq(roomTestCases.roomQuestionId, submission.roomQuestionId), lte(roomTestCases.revision, submission.roomTestRevision)))
    .orderBy(asc(roomTestCases.revision));
  const included = (test: { isHidden: boolean }) => submission.mode === "submit" || !test.isHidden;
  const selected = tests.filter(included);
  const roomSelected = additions.filter(included);

  if (selected.length === 0 && roomSelected.length === 0) {
    await db
      .update(submissions)
      .set({ status: "failed", overall: "internal_error" })
      .where(eq(submissions.id, submissionId));
    await finish(submission.roomId, submissionId, "failed");
    return;
  }

  await db.update(submissions).set({ status: "running" }).where(eq(submissions.id, submissionId));

  const run = (stdin: string) =>
    runInSandbox({
      language: submission.language,
      code: submission.code,
      stdin,
      timeoutMs: config.SANDBOX_TIMEOUT_MS,
      memoryMb: config.SANDBOX_MEMORY_MB,
      cpus: config.SANDBOX_CPUS,
    });

  async function grade(test: { id: string; isHidden: boolean; input: string; expectedOutput: string }): Promise<NewTestResult> {
    const out = await run(test.input);
    return {
      submissionId,
      testCaseId: test.id,
      isHidden: test.isHidden,
      verdict: judge(out, test.expectedOutput),
      timeMs: out.timeMs,
      stdout: test.isHidden ? null : out.stdout,
      stderr: test.isHidden ? null : out.stderr,
    };
  }

  const results: NewTestResult[] = [];
  const roomResults: NewTestResult[] = [];
  for (const test of selected) results.push(await grade(test));
  for (const test of roomSelected) roomResults.push(await grade(test));

  // Participant-written cases (Run only, ADR 0010): same sandbox, separate results, never in `overall`.
  const customCases = submission.mode === "run" ? (submission.customCases ?? []) : [];
  const customResults: (typeof customCaseResults.$inferInsert)[] = [];
  for (const [position, c] of customCases.entries()) {
    const out = await run(c.input);
    customResults.push({
      submissionId,
      position,
      verdict: judgeCustom(out, c.expectedOutput),
      timeMs: out.timeMs,
      stdout: out.stdout,
      stderr: out.stderr,
    });
  }

  // One transaction: results + final status land together. Delete first so a BullMQ retry is idempotent.
  await db.transaction(async (tx) => {
    await tx.delete(testResults).where(eq(testResults.submissionId, submissionId));
    await tx.delete(roomTestResults).where(eq(roomTestResults.submissionId, submissionId));
    await tx.delete(customCaseResults).where(eq(customCaseResults.submissionId, submissionId));
    if (results.length > 0) await tx.insert(testResults).values(results);
    if (roomResults.length > 0) await tx.insert(roomTestResults).values(roomResults);
    if (customResults.length > 0) await tx.insert(customCaseResults).values(customResults);
    await tx
      .update(submissions)
      // Graded on the question's tests only — custom cases never change the verdict.
      .set({ status: "completed", overall: overallVerdict([...results, ...roomResults].map((r) => r.verdict)) })
      .where(eq(submissions.id, submissionId));
  });
  await finish(submission.roomId, submissionId, "completed");
}

const worker = new Worker(EXECUTION_QUEUE, processJob, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

worker.on("failed", async (job, err) => {
  if (job?.name === QUESTION_VALIDATION_JOB) {
    console.error(`question validation job ${job.id} failed`);
    return;
  }
  console.error(`job ${job?.id} failed:`, err.message);
  const attemptsLeft = job ? (job.opts.attempts ?? 1) - job.attemptsMade : 0;
  if (!job || attemptsLeft > 0) return;
  // Out of retries: mark the submission failed so clients stop waiting.
  const parsed = ExecutionJob.safeParse(job.data);
  if (!parsed.success) return;
  try {
    const [row] = await db
      .update(submissions)
      .set({ status: "failed", overall: "internal_error" })
      .where(eq(submissions.id, parsed.data.submissionId))
      .returning({ roomId: submissions.roomId });
    if (row) await finish(row.roomId, parsed.data.submissionId, "failed");
  } catch (e) {
    console.error("could not mark submission failed:", e);
  }
});

const recoveryQueue = new Queue<ExecutionJob>(EXECUTION_QUEUE, { connection });
const stopSweeper = startOutboxSweeper({
  db,
  queue: recoveryQueue,
  intervalMs: config.OUTBOX_SWEEP_INTERVAL_MS,
  staleAfterMs: config.OUTBOX_STALE_AFTER_MS,
});

console.log(`worker started (concurrency=${config.WORKER_CONCURRENCY})`);

const shutdown = async () => {
  stopSweeper();
  await recoveryQueue.close();
  await worker.close();
  await connection.quit();
  await publisher.quit();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
