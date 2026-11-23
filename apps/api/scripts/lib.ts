import path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { AuthClient } from "@supabase/auth-js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

export const API = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
export const SUPABASE_URL = process.env.SUPABASE_URL!;
export const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
export const QUESTION_ID = "00000000-0000-4000-8000-000000000001"; // shared library question (supabase/seed.sql)

let failures = 0;
export const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};
export const finish = () => {
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
};

export async function signUp(label: string) {
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

export const call = async (
  method: string,
  url: string,
  token?: string,
  body?: unknown,
  base = API,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
};

/** The user id (`sub`) inside a Supabase access token. */
export const userIdOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The room question ids of a room, in order (as the interviewer sees them). */
export async function roomQuestionIds(roomId: string, interviewerToken: string): Promise<string[]> {
  const room = await call("GET", `/rooms/${roomId}`, interviewerToken);
  if (room.status !== 200) throw new Error(`get room → ${room.status}`);
  return room.json.questions.map((q: { id: string }) => q.id);
}

/** Interviewer creates a room (one library question unless given), candidate joins it. */
export async function setupRoom(questionIds: string[] = [QUESTION_ID]) {
  const interviewer = await signUp("interviewer");
  const candidate = await signUp("candidate");
  const outsider = await signUp("outsider");
  const created = await call("POST", "/rooms", interviewer, { questionIds });
  if (created.status !== 201) throw new Error(`create room → ${created.status}`);
  const joined = await call("POST", "/rooms/join", candidate, { inviteCode: created.json.inviteCode });
  if (joined.status !== 200) throw new Error(`join room → ${joined.status}`);
  const roomId = created.json.roomId as string;
  const rqIds = await roomQuestionIds(roomId, interviewer);
  return {
    interviewer,
    candidate,
    outsider,
    roomId,
    inviteCode: created.json.inviteCode as string,
    /** The first question (revealed at creation) — what single-question tests submit to. */
    roomQuestionId: rqIds[0]!,
    roomQuestionIds: rqIds,
  };
}
