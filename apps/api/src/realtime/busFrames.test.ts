import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, FrameKind } from "./busFrames.js";
import { parseRoute } from "./gateway.js";

describe("bus frames", () => {
  it("round-trips origin, kind and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 255, 0]);
    const frame = decodeFrame(encodeFrame({ origin: "instance-a", kind: FrameKind.Awareness, payload }));
    expect(frame.origin).toBe("instance-a");
    expect(frame.kind).toBe(FrameKind.Awareness);
    expect([...frame.payload]).toEqual([...payload]);
  });

  it("rejects unknown frame kinds", () => {
    const bad = encodeFrame({ origin: "x", kind: 9 as FrameKind, payload: new Uint8Array() });
    expect(() => decodeFrame(bad)).toThrow(/unknown frame kind/);
  });
});

describe("parseRoute", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("routes yjs and events sockets", () => {
    expect(parseRoute(`/yjs/${id}`)).toEqual({ kind: "yjs", roomId: id });
    expect(parseRoute(`/rooms/${id}/events`)).toEqual({ kind: "events", roomId: id });
  });

  it("ignores query strings", () => {
    expect(parseRoute(`/yjs/${id}?foo=bar`)).toEqual({ kind: "yjs", roomId: id });
  });

  it("rejects unknown paths and non-uuid room ids", () => {
    expect(parseRoute("/yjs/not-a-uuid")).toBeNull();
    expect(parseRoute(`/yjs/${id}/extra`)).toBeNull();
    expect(parseRoute("/health")).toBeNull();
  });
});
