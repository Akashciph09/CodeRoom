import type { CandidateQuestionView, Language, RoomQuestionView, RoomView } from "@coderoom/shared";

/*
 * Per-question state in the shared Yjs doc (ADR 0009). Keyed by the question's position, which never
 * changes within a room. Question 1 keeps the original single-question names ("code", "language",
 * "initialized"), so rooms created before multi-question rooms keep their code.
 */

/** Name of the Y.Text holding question `position`'s code. */
export const codeKey = (position: number) => (position === 1 ? "code" : `code:${position}`);

/** Name of the Y.Array holding question `position`'s shared custom test cases (ADR 0010). */
export const casesKey = (position: number) => `cases:${position}`;

/** A custom test case as stored in the shared doc. */
export interface SharedCase {
  id: string;
  input: string;
  expectedOutput?: string;
  addedBy: { name: string; role: "interviewer" | "candidate" };
}

/**
 * Doc contents are written by the other participant's client, so read them defensively: anything that
 * isn't a well-formed case is skipped (and everything is rendered as text, never HTML).
 */
export function parseSharedCases(items: unknown[]): SharedCase[] {
  return items.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const c = raw as Record<string, unknown>;
    const by = c.addedBy as Record<string, unknown> | undefined;
    if (typeof c.id !== "string" || typeof c.input !== "string") return [];
    if (c.expectedOutput !== undefined && typeof c.expectedOutput !== "string") return [];
    const role = by?.role === "interviewer" ? "interviewer" : "candidate";
    const name = typeof by?.name === "string" ? by.name.slice(0, 80) : "Someone";
    return [{ id: c.id, input: c.input, ...(c.expectedOutput !== undefined ? { expectedOutput: c.expectedOutput } : {}), addedBy: { name, role } }];
  });
}

/** Key of a per-question setting in the doc's "meta" map. */
export const metaKey = (name: "language" | "initialized", position: number) =>
  position === 1 ? name : `${name}:${position}`;

/** Used when the question's author didn't provide starter code for a language. */
export const DEFAULT_STARTER: Record<Language, string> = {
  python: "import sys\n\n\ndef solve(data: str) -> str:\n    # TODO\n    return \"\"\n\n\nprint(solve(sys.stdin.read()))\n",
  javascript:
    "const input = require('fs').readFileSync(0, 'utf8');\n\nfunction solve(data) {\n  // TODO\n  return '';\n}\n\nconsole.log(solve(input));\n",
};

export const starterFor = (question: CandidateQuestionView, language: Language) =>
  question.starterCode[language] ?? DEFAULT_STARTER[language];

/** Start in the first language the author wrote starter code for (Python if both or neither). */
export const initialLanguage = (question: CandidateQuestionView): Language =>
  question.starterCode.python !== undefined || question.starterCode.javascript === undefined ? "python" : "javascript";

export const revealedQuestions = (room: RoomView) => room.questions.filter((q) => q.revealed);

/** The most recently revealed question (where both sides start, and where a candidate is taken on reveal). */
export const latestRevealed = (room: RoomView): RoomQuestionView | undefined => revealedQuestions(room).at(-1);

/** The only question the interviewer may reveal now (questions are revealed in order), if any. */
export const nextToReveal = (room: RoomView): RoomQuestionView | undefined => room.questions.find((q) => !q.revealed);

/**
 * Apply a freshly fetched room. Fetches can resolve out of order (a reconnect refresh racing a reveal
 * event), so state only moves forward: a question stays revealed and an ended room stays ended.
 */
export function mergeRoom(prev: RoomView | null, next: RoomView): RoomView {
  if (!prev || prev.roomId !== next.roomId) return next;
  const wasRevealed = new Set(prev.questions.filter((q) => q.revealed).map((q) => q.id));
  const byId = new Map(next.questions.map((q) => [q.id, q]));
  // A candidate's older snapshot may hold a question a stale response lacks; keep it.
  const questions = [
    ...next.questions.map((q) => (wasRevealed.has(q.id) && !q.revealed ? { ...q, revealed: true } : q)),
    ...prev.questions.filter((q) => !byId.has(q.id) && q.revealed),
  ].sort((a, b) => a.position - b.position);
  return { ...next, status: prev.status === "closed" ? "closed" : next.status, questions };
}
