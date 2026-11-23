import { describe, expect, it } from "vitest";
import { elapsedMs, formatElapsed } from "./timer";

describe("interview timer", () => {
  const createdAt = "2026-01-01T10:00:00.000Z";
  it("counts from creation to the server's now, independent of this machine's clock", () => {
    expect(elapsedMs({ createdAt, nowOnServer: Date.parse("2026-01-01T10:12:34.000Z") })).toBe(754_000);
  });
  it("stops at the session's end", () => {
    const closedAt = "2026-01-01T10:45:00.000Z";
    expect(elapsedMs({ createdAt, closedAt, nowOnServer: Date.parse("2026-01-01T12:00:00.000Z") })).toBe(45 * 60_000);
  });
  it("never goes negative (clock skew right after creation)", () => {
    expect(elapsedMs({ createdAt, nowOnServer: Date.parse("2026-01-01T09:59:59.000Z") })).toBe(0);
  });
  it("formats as m:ss, then h:mm:ss", () => {
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(754_000)).toBe("12:34");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});
