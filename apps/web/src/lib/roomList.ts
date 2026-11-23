import type { RoomCandidate, RoomSummary } from "@coderoom/shared";

/*
 * Presentation helpers for the "Your rooms" list (ADR 0013). Pure, so they're unit-tested directly.
 */

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const full = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "medium" });

/**
 * "23 Nov, 18:20" — with the year when it isn't the current one ("23 Nov 2025, 18:20"). `full` is the
 * complete timestamp for hover and assistive technology.
 */
export function formatRoomDate(iso: string, now: Date = new Date()): { short: string; full: string } {
  const d = new Date(iso);
  const date = d.getFullYear() === now.getFullYear() ? dayMonth.format(d) : dayMonthYear.format(d);
  return { short: `${date}, ${time.format(d)}`, full: full.format(d) };
}

/** Status as shown in the list: a closed room is an interview that has ended. */
export const roomStatusLabel = (status: RoomSummary["status"]) => (status === "closed" ? "Ended" : "Open");

export const roleLabel = (role: RoomSummary["role"]) => (role === "interviewer" ? "Interviewer" : "Candidate");

/**
 * The Candidate cell: the first candidate, plus "+N" for rooms from before one-candidate-per-room
 * (ADR 0012) that have more. `others` names the collapsed ones (for hover / screen readers).
 * Null when nobody joined.
 */
export function candidateCell(candidates: RoomCandidate[]): { first: RoomCandidate; more: number; others: string } | null {
  const [first, ...rest] = candidates;
  if (!first) return null;
  return { first, more: rest.length, others: rest.map((c) => `${c.name} (${c.email})`).join(", ") };
}

/** Search: the question title, or any candidate's name or email — including ones collapsed into "+N". */
export function roomMatches(room: Pick<RoomSummary, "questionTitle" | "candidates">, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    room.questionTitle.toLowerCase().includes(needle) ||
    (room.candidates ?? []).some((c) => c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle))
  );
}
