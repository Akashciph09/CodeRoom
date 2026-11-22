/**
 * Question authoring + versioning against the running stack (supabase, redis, api, worker).
 *   pnpm smoke   (runs smoke.ts, then this)
 *
 * The key guarantee: a room pins the question version it was created with. Editing and re-publishing
 * the question must not change the tests an existing room runs, or the results it already has.
 */
import { createDb, eq, questionVersions, testCases } from "@coderoom/db";
import { call, check, finish, signUp, sleep } from "./lib.js";

const SUM = "a, b = map(int, input().split())\nprint(a + b)";

/** Drizzle wraps Postgres errors ("Failed query: …"); the trigger's message is on `cause`. */
const dbError = (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message;

async function waitFor(id: string, token: string) {
  for (let i = 0; i < 80; i++) {
    const { json } = await call("GET", `/submissions/${id}`, token);
    if (json?.status === "completed" || json?.status === "failed") return json;
    await sleep(250);
  }
  throw new Error(`submission ${id} did not finish`);
}

async function main() {
  const owner = await signUp("author");
  const other = await signUp("other-author");
  const candidate = await signUp("candidate");

  // --- Create + draft -----------------------------------------------------------------------------
  const created = await call("POST", "/questions", owner, { title: "Add two numbers" });
  const qid = created.json?.id as string;
  check("create question → draft", created.status === 201 && created.json.draft?.status === "draft" && !created.json.latest);
  const mine0 = await call("GET", "/questions/mine", owner);
  check(
    "My questions lists it as draft",
    mine0.json.some((q: any) => q.id === qid && q.status === "draft" && q.latestVersion === null),
  );

  // --- Ownership --------------------------------------------------------------------------------------
  check("non-owner can't read it → 404", (await call("GET", `/questions/${qid}`, other)).status === 404);
  check(
    "non-owner can't edit it → 404",
    (await call("PUT", `/questions/${qid}/draft`, other, { title: "x", statement: "", tests: [] })).status === 404,
  );
  check("non-owner can't publish it → 404", (await call("POST", `/questions/${qid}/publish`, other)).status === 404);

  // --- Publish validation ------------------------------------------------------------------------------
  await call("PUT", `/questions/${qid}/draft`, owner, {
    title: "Add two numbers",
    statement: "Print a + b.",
    tests: [{ input: "1 2\n", expectedOutput: "3", isHidden: true }],
  });
  const blocked = await call("POST", `/questions/${qid}/publish`, owner);
  check(
    "can't mark ready without a public test → 400 with problems",
    blocked.status === 400 && blocked.json.problems?.includes("no_public_tests"),
    `(${blocked.json?.problems})`,
  );
  check("can't open a room with a draft-only question → 400", (await call("POST", "/rooms", owner, { questionId: qid })).status === 400);

  // --- v1 ------------------------------------------------------------------------------------------------
  const v1Draft = {
    title: "Add two numbers",
    statement: "Read a and b, print a + b.",
    constraints: "-1000 <= a, b <= 1000",
    starterCode: { python: "a, b = map(int, input().split())\n" },
    tests: [
      { input: "1 2\n", expectedOutput: "3", isHidden: false },
      { input: "5 5\n", expectedOutput: "10", isHidden: true },
    ],
  };
  const saved = await call("PUT", `/questions/${qid}/draft`, owner, v1Draft);
  check("save draft with tests", saved.status === 200 && saved.json.draft.tests.length === 2);
  const p1 = await call("POST", `/questions/${qid}/publish`, owner);
  check("mark ready → version 1", p1.status === 200 && p1.json.latest?.version === 1 && p1.json.draft === null);

  const preview = await call("GET", `/questions/${qid}/preview?of=latest`, owner);
  check(
    "preview = candidate view (public tests only)",
    preview.json.publicTests?.length === 1 && preview.json.hiddenTestCount === 1 && !JSON.stringify(preview.json).includes("5 5"),
  );
  check("non-owner can't preview → 404", (await call("GET", `/questions/${qid}/preview`, other)).status === 404);

  const usableByOwner = await call("GET", "/questions", owner);
  const usableByOther = await call("GET", "/questions", other);
  check(
    "ready question is offered to its owner (v1), not to others",
    usableByOwner.json.some((q: any) => q.id === qid && q.version === 1 && q.owned) &&
      !usableByOther.json.some((q: any) => q.id === qid),
  );
  check("others can't open a room with it → 404", (await call("POST", "/rooms", other, { questionId: qid })).status === 404);

  // --- Room 1 pins v1 -----------------------------------------------------------------------------------
  const r1 = await call("POST", "/rooms", owner, { questionId: qid });
  await call("POST", "/rooms/join", candidate, { inviteCode: r1.json.inviteCode });
  const room1 = await call("GET", `/rooms/${r1.json.roomId}`, candidate);
  check(
    "room shows v1 statement, constraints, starter code",
    room1.json.question?.version === 1 &&
      room1.json.question.statement === v1Draft.statement &&
      room1.json.question.constraints === v1Draft.constraints &&
      room1.json.question.starterCode.python === v1Draft.starterCode.python,
  );
  const s1 = await call("POST", "/submissions", candidate, { roomId: r1.json.roomId, language: "python", mode: "submit", code: SUM });
  const s1done = await waitFor(s1.json.submissionId, candidate);
  check("submission in room 1 → accepted on v1 tests", s1done.overall === "accepted" && s1done.hiddenTotal === 1);

  // --- Edit → v2 (different expected outputs) ---------------------------------------------------------
  const v2Draft = {
    ...v1Draft,
    title: "Multiply two numbers",
    statement: "Read a and b, print a * b.",
    tests: [
      { input: "2 3\n", expectedOutput: "6", isHidden: false },
      { input: "4 5\n", expectedOutput: "20", isHidden: true },
    ],
  };
  await call("PUT", `/questions/${qid}/draft`, owner, v2Draft);
  const mine1 = await call("GET", "/questions/mine", owner);
  check(
    "editing a ready question → 'ready v1 + unpublished changes'",
    mine1.json.some((q: any) => q.id === qid && q.status === "ready" && q.latestVersion === 1 && q.hasUnpublishedChanges),
  );
  const room1Mid = await call("GET", `/rooms/${r1.json.roomId}`, candidate);
  check("unpublished edits don't reach an existing room", room1Mid.json.question.statement === v1Draft.statement);
  const p2 = await call("POST", `/questions/${qid}/publish`, owner);
  check("mark ready again → version 2", p2.json.latest?.version === 2 && p2.json.versions.length === 2);

  // --- Room 1 still runs v1; room 2 runs v2 -----------------------------------------------------------
  const room1After = await call("GET", `/rooms/${r1.json.roomId}`, candidate);
  check("existing room still shows v1 after v2 is ready", room1After.json.question.version === 1 && room1After.json.question.statement === v1Draft.statement);
  const s1again = await call("GET", `/submissions/${s1.json.submissionId}`, candidate);
  check("existing result unchanged", s1again.json.overall === "accepted" && s1again.json.publicResults[0].testId === s1done.publicResults[0].testId);
  const s2 = await call("POST", "/submissions", candidate, { roomId: r1.json.roomId, language: "python", mode: "submit", code: SUM });
  check("new submission in room 1 is still graded on v1 tests", (await waitFor(s2.json.submissionId, candidate)).overall === "accepted");

  const r2 = await call("POST", "/rooms", owner, { questionId: qid });
  await call("POST", "/rooms/join", candidate, { inviteCode: r2.json.inviteCode });
  const room2 = await call("GET", `/rooms/${r2.json.roomId}`, candidate);
  check("a new room uses v2", room2.json.question.version === 2 && room2.json.question.statement === v2Draft.statement);
  const s3 = await call("POST", "/submissions", candidate, { roomId: r2.json.roomId, language: "python", mode: "submit", code: SUM });
  check("…and grades on v2 tests (sum code now wrong)", (await waitFor(s3.json.submissionId, candidate)).overall === "wrong_answer");

  // --- Discard / delete -------------------------------------------------------------------------------
  await call("PUT", `/questions/${qid}/draft`, owner, { ...v2Draft, title: "scratch edit" });
  const discarded = await call("DELETE", `/questions/${qid}/draft`, owner);
  check("discard draft → back to the ready version", discarded.status === 200 && discarded.json.draft === null && discarded.json.latest.version === 2);
  check("ready questions can't be deleted → 409", (await call("DELETE", `/questions/${qid}`, owner)).status === 409);
  const throwaway = await call("POST", "/questions", owner, {});
  check("never-ready question can be deleted → 204", (await call("DELETE", `/questions/${throwaway.json.id}`, owner)).status === 204);

  // --- Immutability is enforced by the database, not just the API -------------------------------------
  const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
  try {
    const v1Id = p2.json.versions.find((v: any) => v.version === 1).id as string;
    const tamper = await db
      .update(testCases)
      .set({ expectedOutput: "999" })
      .where(eq(testCases.versionId, v1Id))
      .then(() => "allowed", dbError);
    check("DB rejects editing a published version's tests", /immutable/.test(tamper), `(${tamper.slice(0, 70)})`);
    const retitle = await db
      .update(questionVersions)
      .set({ title: "changed" })
      .where(eq(questionVersions.id, v1Id))
      .then(() => "allowed", dbError);
    check("DB rejects editing a published version", /immutable/.test(retitle), `(${retitle.slice(0, 70)})`);
  } finally {
    await close();
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
