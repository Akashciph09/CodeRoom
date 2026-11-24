import { describe, expect, it } from "vitest";
import { candidateCell, formatRoomDate, roleLabel, roomMatches, roomStatusLabel } from "./roomList";

const casey = { name: "Casey Candidate", email: "casey@example.test" };
const sam = { name: "Sam Second", email: "sam.second@example.test" };
const lee = { name: "Lee Third", email: "lee@example.test" };

describe("room list helpers", () => {
  it("formats dates compactly, adding the year only when it isn't this year", () => {
    const now = new Date(2026, 10, 30, 12, 0);
    expect(formatRoomDate(new Date(2026, 10, 23, 18, 20, 13).toISOString(), now).short).toBe("23 Nov, 18:20");
    expect(formatRoomDate(new Date(2025, 0, 5, 9, 4).toISOString(), now).short).toBe("5 Jan 2025, 09:04");
    // The full timestamp (hover / screen readers) has the weekday, full month, year and seconds.
    expect(formatRoomDate(new Date(2026, 10, 23, 18, 20, 13).toISOString(), now).full).toMatch(/Monday.*23 November 2026.*18:20:13/);
  });

  it("labels status and role", () => {
    expect(roomStatusLabel("closed")).toBe("Ended");
    expect(roomStatusLabel("open")).toBe("Open");
    expect(roleLabel("interviewer")).toBe("Interviewer");
    expect(roleLabel("candidate")).toBe("Candidate");
  });

  it("shows nobody, one candidate, or the first plus +N for legacy rooms", () => {
    expect(candidateCell([])).toBeNull();
    expect(candidateCell([casey])).toEqual({ first: casey, more: 0, others: "" });
    expect(candidateCell([casey, sam, lee])).toEqual({
      first: casey,
      more: 2,
      others: "Sam Second (sam.second@example.test), Lee Third (lee@example.test)",
    });
  });

  it("searches the question and every candidate, including collapsed ones", () => {
    const room = { questionTitle: "Maximum Subarray Sum", candidates: [casey, sam] };
    expect(roomMatches(room, "")).toBe(true);
    expect(roomMatches(room, "  subarray ")).toBe(true);
    expect(roomMatches(room, "CASEY")).toBe(true);
    expect(roomMatches(room, "sam.second@")).toBe(true); // the collapsed "+1" candidate
    expect(roomMatches(room, "nobody")).toBe(false);
    expect(roomMatches({ questionTitle: "Sum two numbers" }, "casey")).toBe(false); // candidate rows carry no details
    expect(roomMatches({ ...room, name: "SRE interview" }, "sre")).toBe(true); // the room's name (ADR 0014)
  });
});
