import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { EXECUTION_JOB_OPTIONS, EXECUTION_QUEUE, QUESTION_VALIDATION_JOB, QuestionValidationResult, type ExecutionJob, type QuestionValidationJob } from "@coderoom/shared";
import { HIDDEN_CASE_REPLAY_JOB, HiddenCaseReplayResult, hiddenCaseReplayChannel, type HiddenCaseReplayJob } from "@coderoom/shared";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const executionQueue = new Queue<ExecutionJob | QuestionValidationJob | HiddenCaseReplayJob>(EXECUTION_QUEUE, {
  connection: redis,
  defaultJobOptions: EXECUTION_JOB_OPTIONS,
});

export async function replayHiddenCase(submissionId: string, testId: string) {
  const requestId = randomUUID();
  const channel = hiddenCaseReplayChannel(requestId);
  const timeoutMs = 15_000;
  const expiresAt = Date.now() + timeoutMs;
  const subscriber = redis.duplicate({ maxRetriesPerRequest: 1 });
  subscriber.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<HiddenCaseReplayResult | undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    subscriber.once("message", (_channel, message) => {
      try {
        const parsed = HiddenCaseReplayResult.safeParse(JSON.parse(message));
        resolve(parsed.success ? parsed.data : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
  // Subscribe before enqueueing so a fast worker can't publish before we are listening.
  const enqueue = async () => {
    try {
      await subscriber.subscribe(channel);
      if (Date.now() >= expiresAt) return;
      await executionQueue.add(HIDDEN_CASE_REPLAY_JOB, { submissionId, testId, requestId, expiresAt }, {
        attempts: 1, removeOnComplete: true, removeOnFail: true,
      });
      return result;
    } catch {
      return undefined;
    }
  };
  try {
    return await Promise.race([enqueue(), result]);
  } finally {
    clearTimeout(timer);
    subscriber.disconnect();
  }
}

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
