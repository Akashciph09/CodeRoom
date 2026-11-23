import { useEffect, useMemo, useState } from "react";
import { elapsedMs, formatElapsed } from "../lib/timer";

/**
 * Time since the interview room was created (interviewer only, ADR 0010). Uses the server's timestamps
 * and corrects for this machine's clock offset; stops at the session's end.
 */
export function InterviewTimer({
  createdAt,
  closedAt,
  serverTime,
  ended,
}: {
  createdAt: string;
  closedAt?: string;
  serverTime: string;
  /** Ended but `closedAt` not loaded yet: freeze where it is until it arrives. */
  ended: boolean;
}) {
  // serverTime was "now" on the server when this room view was produced.
  const offset = useMemo(() => Date.parse(serverTime) - Date.now(), [serverTime]);
  const [now, setNow] = useState(() => Date.now());
  const running = !ended && !closedAt;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const ms = elapsedMs({ createdAt, closedAt, nowOnServer: now + offset });
  return (
    <span
      className={`timer ${running ? "" : "stopped"}`}
      role="timer"
      aria-label="Interview time"
      title={`Since the room was created${closedAt ? " · stopped when the session ended" : ""}`}
    >
      <span aria-hidden="true">⏱</span> {formatElapsed(ms)}
    </span>
  );
}
