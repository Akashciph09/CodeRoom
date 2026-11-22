import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { EXECUTION_QUEUE, type ExecutionJob } from "@coderoom/shared";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const executionQueue = new Queue<ExecutionJob>(EXECUTION_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 500 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueExecution(job: ExecutionJob) {
  // jobId = submissionId makes enqueueing idempotent.
  await executionQueue.add("execute", job, { jobId: job.submissionId });
}
