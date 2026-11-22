import type { Queue } from "bullmq";
import { and, asc, eq, sql, submissions, type Db } from "@coderoom/db";
import { EXECUTION_JOB_OPTIONS, type ExecutionJob } from "@coderoom/shared";

/**
 * Transactional-outbox recovery. The `submissions` row is the source of truth: the API inserts it
 * and then enqueues a job. If the enqueue fails (Redis blip, API crash between the two steps),
 * the row would sit in `queued` forever. This sweeper re-enqueues such rows.
 *
 * Safe to run on every worker: jobId = submissionId, so BullMQ ignores an add for a job that is
 * already waiting, active or retained.
 */
export async function sweepStaleQueued(
  db: Db,
  queue: Queue<ExecutionJob>,
  staleAfterMs: number,
  limit = 100,
): Promise<number> {
  const stale = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.status, "queued"),
        sql`${submissions.createdAt} < now() - make_interval(secs => ${staleAfterMs / 1000})`,
      ),
    )
    .orderBy(asc(submissions.createdAt))
    .limit(limit);

  for (const { id } of stale) {
    await queue.add("execute", { submissionId: id }, { ...EXECUTION_JOB_OPTIONS, jobId: id });
  }
  return stale.length;
}

export function startOutboxSweeper(opts: {
  db: Db;
  queue: Queue<ExecutionJob>;
  intervalMs: number;
  staleAfterMs: number;
}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await sweepStaleQueued(opts.db, opts.queue, opts.staleAfterMs);
      if (n > 0) console.log(`outbox: re-enqueued ${n} stale submission(s)`);
    } catch (err) {
      console.error("outbox sweep failed:", err);
    } finally {
      running = false;
    }
  }, opts.intervalMs);
  return () => clearInterval(timer);
}
