import type { SubmissionView } from "./api";

export type SubmissionEntry =
  | { submissionId: string; pending: true }
  | { submissionId: string; pending: false; view: SubmissionView };

/**
 * How far along a submission is. Results only move forward: a slower source (a history request
 * that started before a result event arrived) must never replace a later state with an earlier one.
 */
export function progress(e: SubmissionEntry): number {
  if (e.pending) return 0;
  switch (e.view.status) {
    case "queued":
      return 1;
    case "running":
      return 2;
    case "completed":
    case "failed":
      return 3;
  }
}

/** Keep `incoming` unless it is behind what we already have. Ties go to the incoming (newer) copy. */
export function newer(current: SubmissionEntry | undefined, incoming: SubmissionEntry): SubmissionEntry {
  return current && progress(current) > progress(incoming) ? current : incoming;
}

/** Apply one event/result to the list (new submissions go on top). */
export function upsertEntry(list: SubmissionEntry[], incoming: SubmissionEntry): SubmissionEntry[] {
  const i = list.findIndex((e) => e.submissionId === incoming.submissionId);
  if (i === -1) return [incoming, ...list];
  const next = list.slice();
  next[i] = newer(list[i], incoming);
  return next;
}

/**
 * Merge a server history snapshot into what we have. The server decides order and membership,
 * but per submission we keep whichever copy is further along. Local placeholders the server
 * doesn't know about yet (a POST still in flight) stay on top.
 */
export function mergeHistory(current: SubmissionEntry[], history: SubmissionView[]): SubmissionEntry[] {
  const byId = new Map(current.map((e) => [e.submissionId, e]));
  const known = new Set(history.map((v) => v.submissionId));
  const localOnly = current.filter((e) => !known.has(e.submissionId));
  const merged = history.map((view) =>
    newer(byId.get(view.submissionId), { submissionId: view.submissionId, pending: false, view }),
  );
  return [...localOnly, ...merged];
}
