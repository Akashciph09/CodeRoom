import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { EXECUTION_JOB_OPTIONS, EXECUTION_QUEUE, QUESTION_VALIDATION_JOB, QuestionValidationResult, type ExecutionJob, type QuestionValidationJob } from "@coderoom/shared";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const executionQueue = new Queue<ExecutionJob | QuestionValidationJob>(EXECUTION_QUEUE, {
  connection: redis,
  defaultJobOptions: EXECUTION_JOB_OPTIONS,
});

export async function enqueueExecution(job: ExecutionJob) {
  // jobId = submissionId makes enqueueing idempotent (also relied on by the worker's outbox sweeper).
  await executionQueue.add("execute", job, { jobId: job.submissionId });
}


let validationEvents: QueueEvents | undefined;
const VALIDATION_TIMEOUT_MS = 40_000;

export async function validateGeneratedTests(referencePython: string, tests: QuestionValidationJob["tests"]) {
  const events = validationEvents ??= new QueueEvents(EXECUTION_QUEUE, { connection: redis });
  const job = await executionQueue.add(QUESTION_VALIDATION_JOB, {
    referencePython,
    tests,
    expiresAt: Date.now() + VALIDATION_TIMEOUT_MS,
  }, {
    attempts: 1,
    removeOnComplete: { age: 60, count: 100 },
    removeOnFail: { age: 60, count: 100 },
  });
  try {
    return QuestionValidationResult.parse(await job.waitUntilFinished(events, VALIDATION_TIMEOUT_MS));
  } finally {
    // A pending job can be removed after a deadline; an active worker owns its sandbox cleanup.
    await job.remove().catch(() => {});
  }
}
