import { UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { asc, createDb, eq, submissions, testCases, testResults, type NewTestResult } from "@coderoom/db";
import { EXECUTION_QUEUE, ExecutionJob, roomEventsChannel, type RoomBusEvent } from "@coderoom/shared";
import { config } from "./config.js";
import { runInSandbox } from "./sandbox/runner.js";
import { judge, overallVerdict } from "./sandbox/verdict.js";

const { db, close: closeDb } = createDb(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY + 2 });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(config.REDIS_URL);

/** Tell realtime gateways the submission finished; they load results and push role-specific views. */
async function finish(roomId: string, submissionId: string, status: "completed" | "failed") {
  const event: RoomBusEvent = { type: "submission:done", roomId, submissionId, status };
  await publisher.publish(roomEventsChannel(roomId), JSON.stringify(event));
}

async function processJob(job: Job) {
  const { submissionId } = ExecutionJob.parse(job.data);

  const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!submission) throw new UnrecoverableError(`Submission ${submissionId} not found`);

  const tests = await db
    .select()
    .from(testCases)
    .where(eq(testCases.questionId, submission.questionId))
    .orderBy(asc(testCases.position));
  const selected = tests.filter((t) => submission.mode === "submit" || !t.isHidden);

  if (selected.length === 0) {
    await db
      .update(submissions)
      .set({ status: "failed", overall: "internal_error" })
      .where(eq(submissions.id, submissionId));
    await finish(submission.roomId, submissionId, "failed");
    return;
  }

  await db.update(submissions).set({ status: "running" }).where(eq(submissions.id, submissionId));

  const results: NewTestResult[] = [];
  for (const test of selected) {
    const out = await runInSandbox({
      language: submission.language,
      code: submission.code,
      stdin: test.input,
      timeoutMs: config.SANDBOX_TIMEOUT_MS,
      memoryMb: config.SANDBOX_MEMORY_MB,
      cpus: config.SANDBOX_CPUS,
    });
    results.push({
      submissionId,
      testCaseId: test.id,
      isHidden: test.isHidden,
      verdict: judge(out, test.expectedOutput),
      timeMs: out.timeMs,
      // Never store output for hidden tests (also enforced by a CHECK constraint).
      stdout: test.isHidden ? null : out.stdout,
      stderr: test.isHidden ? null : out.stderr,
    });
  }

  // One transaction: results + final status land together. Delete first so a BullMQ retry is idempotent.
  await db.transaction(async (tx) => {
    await tx.delete(testResults).where(eq(testResults.submissionId, submissionId));
    await tx.insert(testResults).values(results);
    await tx
      .update(submissions)
      .set({ status: "completed", overall: overallVerdict(results.map((r) => r.verdict)) })
      .where(eq(submissions.id, submissionId));
  });
  await finish(submission.roomId, submissionId, "completed");
}

const worker = new Worker(EXECUTION_QUEUE, processJob, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

worker.on("failed", async (job, err) => {
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

console.log(`worker started (concurrency=${config.WORKER_CONCURRENCY})`);

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  await publisher.quit();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
