/**
 * Realtime gateway smoke test. Needs supabase, redis, worker and one or two API instances.
 *   pnpm smoke:realtime                         # everything against :4000
 *   SMOKE_API_URL_2=http://localhost:4001 ...   # candidate on a second instance (cross-instance sync)
 */
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { REALTIME_PROTOCOL, type ServerEvent } from "@coderoom/shared";
import { API, call, check, finish, setupRoom, sleep } from "./lib.js";

const API_B = process.env.SMOKE_API_URL_2 ?? API;
const wsUrl = (http: string) => http.replace(/^http/, "ws");
const PERSIST_WAIT_MS = Number(process.env.DOC_PERSIST_DEBOUNCE_MS ?? 2000) + 1500;

/** Status code the server answered an upgrade with (101 = accepted). */
function upgradeStatus(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols);
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
}

function provider(base: string, roomId: string, token: string) {
  const doc = new Y.Doc();
  const p = new WebsocketProvider(`${wsUrl(base)}/yjs`, roomId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    protocols: [REALTIME_PROTOCOL, token],
    disableBc: true,
  });
  const synced = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sync timeout")), 5000);
    p.on("sync", (ok: boolean) => {
      if (ok) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { doc, text: doc.getText("code"), p, synced };
}

function waitForText(text: Y.Text, predicate: (s: string) => boolean, timeoutMs = 3000) {
  return new Promise<number>((resolve, reject) => {
    const t0 = performance.now();
    if (predicate(text.toString())) return resolve(0);
    const timer = setTimeout(() => {
      text.unobserve(fn);
      reject(new Error(`timeout; text=${JSON.stringify(text.toString().slice(-40))}`));
    }, timeoutMs);
    const fn = () => {
      if (!predicate(text.toString())) return;
      clearTimeout(timer);
      text.unobserve(fn);
      resolve(performance.now() - t0);
    };
    text.observe(fn);
  });
}

function eventSocket(base: string, roomId: string, token: string) {
  const ws = new WebSocket(`${wsUrl(base)}/rooms/${roomId}/events`, [REALTIME_PROTOCOL, token]);
  const events: ServerEvent[] = [];
  ws.on("message", (data) => events.push(JSON.parse(data.toString())));
  const ready = new Promise<void>((resolve) => ws.on("message", () => resolve()));
  const waitFor = async (pred: (e: ServerEvent) => boolean, timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find(pred);
      if (found) return found;
      await sleep(50);
    }
    throw new Error("event timeout");
  };
  return { ws, events, ready, waitFor };
}

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

async function main() {
  const crossInstance = API_B !== API;
  console.log(`interviewer → ${API}, candidate → ${API_B}${crossInstance ? " (cross-instance)" : ""}\n`);
  const { interviewer, candidate, outsider, roomId } = await setupRoom();
  const yjsA = `${wsUrl(API)}/yjs/${roomId}`;

  // --- Upgrade authorization -------------------------------------------------------------------
  check("no subprotocol → 400", (await upgradeStatus(yjsA, [])) === 400);
  check("missing token → 401", (await upgradeStatus(yjsA, [REALTIME_PROTOCOL])) === 401);
  check("bad token → 401", (await upgradeStatus(yjsA, [REALTIME_PROTOCOL, "not.a.jwt"])) === 401);
  check("outsider → 403", (await upgradeStatus(yjsA, [REALTIME_PROTOCOL, outsider])) === 403);
  check("unknown path → 404", (await upgradeStatus(`${wsUrl(API)}/yjs/nope`, [REALTIME_PROTOCOL, interviewer])) === 404);
  check("participant → 101", (await upgradeStatus(yjsA, [REALTIME_PROTOCOL, candidate])) === 101);

  // --- Sync ------------------------------------------------------------------------------------
  const iv = provider(API, roomId, interviewer);
  const cd = provider(API_B, roomId, candidate);
  await Promise.all([iv.synced, cd.synced]);
  check("both clients synced", true);

  // Latency: one edit at a time, measured until it appears on the other client.
  const latencies: number[] = [];
  for (let i = 0; i < 30; i++) {
    const [from, to] = i % 2 === 0 ? [iv, cd] : [cd, iv];
    const marker = `<${i}>`;
    const arrived = waitForText(to.text, (s) => s.includes(marker));
    const t0 = performance.now();
    from.text.insert(from.text.length, marker);
    await arrived;
    latencies.push(performance.now() - t0);
  }
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  check(
    "edit propagation p95 < 250ms",
    p95 < 250,
    `(p50 ${p50.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, max ${Math.max(...latencies).toFixed(1)}ms, n=${latencies.length})`,
  );

  // Concurrent edits at the same position must converge to the same text.
  for (let i = 0; i < 25; i++) {
    iv.text.insert(0, "I");
    cd.text.insert(0, "C");
  }
  await waitForText(iv.text, (s) => (s.match(/C/g)?.length ?? 0) === 25);
  await waitForText(cd.text, (s) => (s.match(/I/g)?.length ?? 0) === 25);
  check("concurrent edits converge", iv.text.toString() === cd.text.toString(), `(${iv.text.length} chars)`);

  // Awareness (cursors / names) crosses instances too.
  iv.p.awareness.setLocalStateField("user", { name: "Interviewer" });
  const sawAwareness = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    const check = () => {
      const names = [...cd.p.awareness.getStates().values()].map((s) => s.user?.name);
      if (names.includes("Interviewer")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    cd.p.awareness.on("change", check);
    check();
  });
  check("awareness reaches the other client", sawAwareness);

  // --- Live submission events -------------------------------------------------------------------
  const ivEvents = eventSocket(API, roomId, interviewer);
  const cdEvents = eventSocket(API_B, roomId, candidate);
  await Promise.all([ivEvents.ready, cdEvents.ready]);
  const submit = await call("POST", "/submissions", candidate, {
    roomId,
    language: "python",
    mode: "submit",
    code: "a,b=map(int,input().split());print(a+b)",
  });
  const submissionId = submit.json.submissionId as string;
  const isResult = (e: ServerEvent) => e.type === "submission:result" && e.result.submissionId === submissionId;
  await cdEvents.waitFor((e) => e.type === "submission:queued" && e.submissionId === submissionId);
  check("candidate gets submission:queued", true);
  const cdResult = (await cdEvents.waitFor(isResult)) as Extract<ServerEvent, { type: "submission:result" }>;
  const ivResult = (await ivEvents.waitFor(isResult)) as Extract<ServerEvent, { type: "submission:result" }>;
  const cdJson = JSON.stringify(cdResult.result);
  check(
    "candidate result: public only + hidden count",
    !("results" in cdResult.result) && "hiddenTotal" in cdResult.result && cdResult.result.hiddenTotal === 2 && !cdJson.includes('"code"'),
  );
  check(
    "interviewer result: all tests with hidden flag",
    "results" in ivResult.result && ivResult.result.results.filter((r) => r.hidden).length === 2,
  );
  // --- End session: already-open sockets (on both instances) must stop writing -----------------
  const textAtClose = iv.text.toString();
  check("candidate cannot end the session → 403", (await call("POST", `/rooms/${roomId}/close`, candidate)).status === 403);
  check("interviewer ends the session", (await call("POST", `/rooms/${roomId}/close`, interviewer)).status === 200);
  await ivEvents.waitFor((e) => e.type === "room:closed", 3000);
  await cdEvents.waitFor((e) => e.type === "room:closed", 3000);
  check("both participants get room:closed", true);

  cd.text.insert(0, "AFTER-CLOSE ");
  await sleep(1000);
  check("edits on an open socket after close are dropped", !iv.text.toString().includes("AFTER-CLOSE"));
  const lateSubmit = await call("POST", "/submissions", candidate, {
    roomId,
    language: "python",
    mode: "run",
    code: "print(1)",
  });
  check("submissions after close → 400", lateSubmit.status === 400);
  check("ended room still opens read-only → 101", (await upgradeStatus(yjsA, [REALTIME_PROTOCOL, interviewer])) === 101);
  ivEvents.ws.close();
  cdEvents.ws.close();

  // --- Persistence ------------------------------------------------------------------------------
  const finalText = textAtClose;
  iv.p.destroy();
  cd.p.destroy();
  await sleep(PERSIST_WAIT_MS); // last client left → doc persisted and unloaded on every instance
  const fresh = provider(API, roomId, interviewer);
  await fresh.synced;
  check("document persists after everyone leaves", fresh.text.toString() === finalText, `(${fresh.text.length} chars)`);
  fresh.p.destroy();

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
