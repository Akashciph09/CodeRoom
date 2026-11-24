import { describe, expect, it } from "vitest";
import type { NoteView } from "@coderoom/shared";
import { offsetLabel, removeNote, submissionLabel, upsertNote, wasEdited } from "./notes";

const note = (id: string, createdAt: string, extra: Partial<NoteView> = {}): NoteView => ({
  id,
  roomQuestionId: null,
  submissionId: null,
  body: id,
  authorName: "Iris",
  mine: true,
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

describe("notes helpers", () => {
  it("keeps notes oldest first; an edit replaces the note in place", () => {
    const a = note("a", "2026-11-24T10:00:00.000Z");
    const b = note("b", "2026-11-24T10:05:00.000Z");
    const c = note("c", "2026-11-24T10:02:00.000Z");
    expect(upsertNote(upsertNote([a], b), c).map((n) => n.id)).toEqual(["a", "c", "b"]);
    const edited = { ...a, body: "changed", updatedAt: "2026-11-24T11:00:00.000Z" };
    const list = upsertNote([a, c, b], edited);
    expect(list.map((n) => n.id)).toEqual(["a", "c", "b"]);
    expect(list[0]!.body).toBe("changed");
    expect(removeNote(list, "c").map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("knows when a note was edited", () => {
    expect(wasEdited(note("a", "2026-11-24T10:00:00.000Z"))).toBe(false);
    expect(wasEdited(note("a", "2026-11-24T10:00:00.000Z", { updatedAt: "2026-11-24T10:00:01.000Z" }))).toBe(true);
  });

  it("labels times from the start of the interview and names submissions", () => {
    const start = "2026-11-24T10:00:00.000Z";
    expect(offsetLabel("2026-11-24T10:12:40.000Z", start)).toBe("+12:40");
    expect(offsetLabel("2026-11-24T09:59:00.000Z", start)).toBe("+0:00"); // never negative
    expect(submissionLabel({ mode: "submit", status: "completed", overall: "accepted", createdAt: "2026-11-24T10:03:05.000Z" }, start)).toBe(
      "Submit +3:05 · Accepted",
    );
    expect(submissionLabel({ mode: "run", status: "queued", createdAt: "2026-11-24T10:00:09.000Z" }, start)).toBe("Run +0:09 · running");
    expect(submissionLabel({ mode: "run", status: "failed", createdAt: start }, start)).toBe("Run +0:00 · Internal error");
  });
});
