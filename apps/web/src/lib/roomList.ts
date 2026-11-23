import type { RoomCandidateSummary } from "@coderoom/shared";

/**
 * What the room list says about a candidate's attempts (ADR 0013). Only graded Submits have a score;
 * a Submit still grading or one whose grading failed is not "no Submit".
 */
export function submitLabel(c: Pick<RoomCandidateSummary, "score" | "submits">): string {
  const { graded, pending, failed } = c.submits;
  if (graded > 0) return `Score ${c.score}/100${pending > 0 ? " · grading…" : ""}`;
  if (pending > 0) return "Grading…";
  if (failed > 0) return "Grading failed";
  return "No Submit yet";
}
