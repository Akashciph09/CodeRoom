import type { NoteView, Verdict } from "@coderoom/shared";
import { formatElapsed } from "./timer";
import { VERDICT_LABEL } from "./verdicts";

/*
 * Presentation helpers for the interviewer's private notes (ADR 0016). Pure, unit-tested.
 */

/** Oldest first (creation time, then id — the server's order). */
export const byCreation = (a: NoteView, b: NoteView) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** Add or replace one note (from a create/edit response), keeping the list in order. */
export function upsertNote(list: NoteView[], note: NoteView): NoteView[] {
  return [...list.filter((n) => n.id !== note.id), note].sort(byCreation);
}

export const removeNote = (list: NoteView[], id: string) => list.filter((n) => n.id !== id);

/** Edited after it was written (the server sets both on create). */
export const wasEdited = (n: Pick<NoteView, "createdAt" | "updatedAt">) => Date.parse(n.updatedAt) > Date.parse(n.createdAt);

/** "+12:40" from the start of the interview (never negative). */
export const offsetLabel = (iso: string, startIso: string) => `+${formatElapsed(Math.max(0, Date.parse(iso) - Date.parse(startIso)))}`;

/** How a submission is named in the link picker and on a note: "Submit +12:40 · Accepted". */
export function submissionLabel(
  s: { mode: "run" | "submit"; status: string; overall?: Verdict; createdAt: string },
  startIso: string,
): string {
  const done = s.status === "completed" || s.status === "failed";
  const outcome = done ? VERDICT_LABEL[s.overall ?? "internal_error"] : "running";
  return `${s.mode === "submit" ? "Submit" : "Run"} ${offsetLabel(s.createdAt, startIso)} · ${outcome}`;
}
