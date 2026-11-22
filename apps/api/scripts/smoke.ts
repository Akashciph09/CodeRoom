/**
 * End-to-end smoke test against a running stack (supabase, redis, api, worker).
 * Signs up two real Supabase users, creates a room, joins it, and exercises the sandbox.
 *   pnpm smoke
 */
import { randomUUID } from "node:crypto";
import { createDb, submissions } from "@coderoom/db";
import { call, check, finish, PUBLISHABLE_KEY, QUESTION_ID, signUp, SUPABASE_URL, userIdOf } from "./lib.js";

async function waitFor(id: string, token: string, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    const { json } = await call("GET", `/submissions/${id}`, token);
    if (json?.status === "completed" || json?.status === "failed") return json;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`submission ${id} did not finish`);
}

async function main() {
  const interviewer = await signUp("interviewer");
  const candidate = await signUp("candidate");
  const outsider = await signUp("outsider");

  // Rooms
  const created = await call("POST", "/rooms", interviewer, { questionId: QUESTION_ID });
  check("interviewer creates room", created.status === 201);
  const { roomId, inviteCode } = created.json;

  const joined = await call("POST", "/rooms/join", candidate, { inviteCode });
  check("candidate joins with invite code", joined.status === 200 && joined.json.role === "candidate");

  const room = await call("GET", `/rooms/${roomId}`, candidate);
  check(
    "room view shows only public tests",
    room.status === 200 && room.json.question.publicTests.length === 2,
    `(${room.json?.question?.publicTests?.length} public)`,
  );

  // Authorization
  check("no token → 401", (await call("POST", "/submissions", undefined, {})).status === 401);
  check("bad token → 401", (await call("GET", `/rooms/${roomId}`, "not-a-jwt")).status === 401);
  check("outsider reads room → 403", (await call("GET", `/rooms/${roomId}`, outsider)).status === 403);
  const ivSubmit = await call("POST", "/submissions", interviewer, {
    roomId, language: "python", mode: "run", code: "print(1)",
  });
  check("interviewer submitting → 403", ivSubmit.status === 403);
  check(
    "invalid body → 400",
    (await call("POST", "/submissions", candidate, { roomId: "nope" })).status === 400,
  );

  // Sandbox verdicts
  const cases: [string, "python" | "javascript", "run" | "submit", string, string][] = [
    ["correct (submit)", "python", "submit", "a,b=map(int,input().split());print(a+b)", "accepted"],
    ["correct JS (run)", "javascript", "run",
      "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(' ').map(Number);console.log(a+b)", "accepted"],
    ["wrong answer", "python", "submit", "a,b=map(int,input().split());print(a-b)", "wrong_answer"],
    ["runtime error", "python", "run", "raise Exception('boom')", "runtime_error"],
    ["infinite loop", "python", "run", "while True: pass", "time_limit_exceeded"],
    ["memory bomb", "python", "run", "x=[]\nwhile True: x.append(' '*10_000_000)", "memory_limit_exceeded"],
    ["network blocked", "python", "run",
      "import urllib.request;urllib.request.urlopen('http://example.com',timeout=1);print(3)", "runtime_error"],
  ];

  let firstSubmitId = "";
  for (const [name, language, mode, code, expected] of cases) {
    const t0 = Date.now();
    const res = await call("POST", "/submissions", candidate, { roomId, language, mode, code });
    if (res.status !== 202) {
      check(name, false, `POST → ${res.status} ${JSON.stringify(res.json)}`);
      continue;
    }
    if (!firstSubmitId && mode === "submit") firstSubmitId = res.json.submissionId;
    const view = await waitFor(res.json.submissionId, candidate);
    const hidden = view.hiddenTotal !== undefined ? ` hidden ${view.hiddenPassed}/${view.hiddenTotal}` : "";
    check(`sandbox: ${name}`, view.overall === expected, `→ ${view.overall}${hidden} (${Date.now() - t0}ms)`);
  }

  // Views
  const candView = await call("GET", `/submissions/${firstSubmitId}`, candidate);
  check(
    "candidate view: no hidden results or code",
    candView.json.publicResults.length === 2 && candView.json.hiddenTotal === 2 && !("results" in candView.json),
  );
  const ivView = await call("GET", `/submissions/${firstSubmitId}`, interviewer);
  check(
    "interviewer view: all results with hidden flag",
    ivView.json.results?.length === 4 && ivView.json.results.filter((r: any) => r.hidden).length === 2,
  );
  check(
    "outsider reads submission → 403",
    (await call("GET", `/submissions/${firstSubmitId}`, outsider)).status === 403,
  );

  // RLS: the public Supabase API must not expose tables, even to a signed-in user.
  const rest = await fetch(`${SUPABASE_URL}/rest/v1/test_cases?select=*`, {
    headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${candidate}` },
  });
  const rows = (await rest.json()) as unknown[];
  check("RLS: test_cases unreadable via Supabase REST", Array.isArray(rows) && rows.length === 0, `(${rows.length} rows)`);

  // --- Idempotency: the same key twice yields one submission -----------------------------------
  const key = randomUUID();
  const body = { roomId, language: "python", mode: "run", code: "print(3)" };
  const first = await call("POST", "/submissions", candidate, body, undefined, { "idempotency-key": key });
  const again = await call("POST", "/submissions", candidate, body, undefined, { "idempotency-key": key });
  check(
    "idempotent retry returns the same submission",
    first.status === 202 && again.status === 202 && first.json.submissionId === again.json.submissionId &&
      again.headers.get("idempotent-replayed") === "true",
  );
  // (outsider: the candidate has used its 10/min budget by now — key validation runs before role checks)
  check(
    "malformed Idempotency-Key → 400",
    (await call("POST", "/submissions", outsider, body, undefined, { "idempotency-key": "x" })).status === 400,
  );

  // --- Rate limit: a fresh user's 11th attempt within a minute is refused ----------------------
  const spammer = await signUp("spammer");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await call("POST", "/submissions", spammer, {})).status);
  const limited = await call("POST", "/submissions", spammer, {});
  check(
    "rate limit: 429 with Retry-After after 10/min",
    statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429 && limited.status === 429 &&
      Number(limited.headers.get("retry-after")) > 0,
    `(${statuses.join(",")})`,
  );

  // --- Outbox: a queued row with no job (enqueue "failed") is recovered by the worker ----------
  const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
  const [orphan] = await db
    .insert(submissions)
    .values({
      roomId,
      questionId: QUESTION_ID,
      userId: userIdOf(candidate),
      language: "python",
      mode: "run",
      code: "a,b=map(int,input().split());print(a+b)",
      createdAt: new Date(Date.now() - 5 * 60_000), // older than the sweeper's stale threshold
    })
    .returning({ id: submissions.id });
  await close();
  const t0 = Date.now();
  const recovered = await waitFor(orphan!.id, candidate, 160); // sweeper runs every ~10s
  check(
    "outbox: orphaned queued submission is recovered",
    recovered.status === "completed" && recovered.overall === "accepted",
    `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
