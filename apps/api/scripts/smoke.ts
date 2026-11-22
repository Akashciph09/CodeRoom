/**
 * End-to-end smoke test against a running stack (supabase, redis, api, worker).
 * Signs up two real Supabase users, creates a room, joins it, and exercises the sandbox.
 *   pnpm smoke
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { AuthClient } from "@supabase/auth-js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const API = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const QUESTION_ID = "00000000-0000-4000-8000-000000000001"; // from supabase/seed.sql

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

async function signUp(label: string) {
  const auth = new AuthClient({
    url: `${SUPABASE_URL}/auth/v1`,
    headers: { apikey: PUBLISHABLE_KEY },
    persistSession: false,
  });
  const { data, error } = await auth.signUp({
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    password: randomUUID(),
  });
  if (error || !data.session) throw new Error(`sign up failed: ${error?.message ?? "no session"}`);
  return data.session.access_token;
}

const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

async function waitFor(id: string, token: string) {
  for (let i = 0; i < 80; i++) {
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

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
