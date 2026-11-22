import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { EXECUTION_JOB_OPTIONS, EXECUTION_QUEUE, type ExecutionJob } from "@coderoom/shared";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const executionQueue = new Queue<ExecutionJob>(EXECUTION_QUEUE, {
  connection: redis,
  defaultJobOptions: EXECUTION_JOB_OPTIONS,
});

export async function enqueueExecution(job: ExecutionJob) {
  // jobId = submissionId makes enqueueing idempotent (also relied on by the worker's outbox sweeper).
  await executionQueue.add("execute", job, { jobId: job.submissionId });
}
