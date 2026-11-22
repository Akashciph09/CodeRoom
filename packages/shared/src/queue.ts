import { z } from "zod";

export const EXECUTION_QUEUE = "execution";

/** Job payload carries ONLY the submission id; the worker loads everything else. */
export const ExecutionJob = z.object({
  submissionId: z.string().min(1),
});
export type ExecutionJob = z.infer<typeof ExecutionJob>;

/** Redis pub/sub channel the worker publishes to when a submission finishes. */
export const submissionDoneChannel = (submissionId: string) =>
  `submission:${submissionId}:done`;
export const SUBMISSION_DONE_PATTERN = "submission:*:done";
