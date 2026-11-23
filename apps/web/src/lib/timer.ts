/** Elapsed interview time: from creation to the end (if ended) or to the server's current time. */
export function elapsedMs({ createdAt, closedAt, nowOnServer }: { createdAt: string; closedAt?: string; nowOnServer: number }) {
  const end = closedAt ? Date.parse(closedAt) : nowOnServer;
  return Math.max(0, end - Date.parse(createdAt));
}

/** 0:05, 12:34, 1:02:03 */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
