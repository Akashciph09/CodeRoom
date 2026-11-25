import type { SubmissionView } from "./api";
import type { Language, SubmissionMode } from "@coderoom/shared";

type PendingEntry = {
  submissionId: string;
  pending: true;
  roomQuestionId?: string;
  mode?: SubmissionMode;
  language?: Language;
  createdAt?: string;
  roomTestRevision?: number;
};

export type SubmissionEntry =
  /** Accepted, no result yet. `roomQuestionId` is known from our own submit or the queued event. */
  | PendingEntry
  | { submissionId: string; pending: false; view: SubmissionView };

/** The room question an entry answers (undefined only for a placeholder that never learned it). */
export const questionOf = (e: SubmissionEntry) => (e.pending ? e.roomQuestionId : e.view.roomQuestionId);

export const attemptMetadata = (entry: SubmissionEntry) => entry.pending ? entry : entry.view;

export function numberedHistory(entries: SubmissionEntry[], numbers: Readonly<Record<string, number>>) {
  const sorted = entries.flatMap((entry) => {
    const attemptNumber = numbers[entry.submissionId];
    return attemptNumber === undefined ? [] : [{ entry, attemptNumber }];
  }).sort((a, b) => b.attemptNumber - a.attemptNumber);
  // After a long disconnect the new page may not overlap the cached pages. Stop at the first gap.
  const gap = sorted.findIndex((row, index) => index > 0 && sorted[index - 1]!.attemptNumber - row.attemptNumber > 1);
  return gap < 0 ? sorted : sorted.slice(0, gap);
}

/** Acceptance time orders attempts even when the first event we receive is a late result. */
export function attemptsFor(entries: SubmissionEntry[], questionId: string, mode: SubmissionMode) {
  return entries.filter((entry) => questionOf(entry) === questionId && attemptMetadata(entry).mode === mode)
    .sort((a, b) => {
      const aTime = attemptMetadata(a).createdAt;
      const bTime = attemptMetadata(b).createdAt;
      return aTime && bTime
        ? bTime.localeCompare(aTime) || b.submissionId.localeCompare(a.submissionId)
        : Number(Boolean(bTime)) - Number(Boolean(aTime));
    });
}

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
  const current = list[i]!;
  const winner = newer(current, incoming);
  // Two placeholders may get their metadata from different sources during a rolling deploy.
  next[i] =
    winner.pending && current.pending
      ? { ...current, ...winner }
      : winner;
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
