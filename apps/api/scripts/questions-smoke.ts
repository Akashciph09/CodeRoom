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

/**
 * Acts like one open editor tab: remembers the question revision it last saw and sends it back on every
 * save / publish / discard / delete, exactly like the web editor does.
 */
function editorTab(token: string, qid: () => string) {
  let rev = 0;
  const sync = (detail: any) => (rev = detail?.revision ?? rev);
  return {
    get revision() {
      return rev;
    },
    sync,
    async load() {
      const r = await call("GET", `/questions/${qid()}`, token);
      sync(r.json);
      return r;
    },
    async save(body: object) {
      const r = await call("PUT", `/questions/${qid()}/draft`, token, { ...body, baseRevision: rev });
      if (r.status === 200) sync(r.json);
      return r;
    },
    async publish() {
      const r = await call("POST", `/questions/${qid()}/publish`, token, { revision: rev });
      if (r.status === 200) sync(r.json);
      return r;
    },
    async discard() {
      const r = await call("DELETE", `/questions/${qid()}/draft`, token, { revision: rev });
      if (r.status === 200) sync(r.json);
      return r;
    },
    async remove() {
      return call("DELETE", `/questions/${qid()}`, token, { revision: rev });
    },
  };
}

async function main() {
  const owner = await signUp("author");
  const other = await signUp("other-author");
  const candidate = await signUp("candidate");

  // --- Create + draft -----------------------------------------------------------------------------
  const created = await call("POST", "/questions", owner, { title: "Add two numbers" });
  const qid = created.json?.id as string;
  const tab = editorTab(owner, () => qid);
  tab.sync(created.json);
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
  await tab.save({
    title: "Add two numbers",
    statement: "Print a + b.",
    tests: [{ input: "1 2\n", expectedOutput: "3", isHidden: true }],
  });
  const blocked = await tab.publish();
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
  const saved = await tab.save(v1Draft);
  check("save draft with tests", saved.status === 200 && saved.json.draft.tests.length === 2);
  const p1 = await tab.publish();
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
  await tab.save(v2Draft);
  const mine1 = await call("GET", "/questions/mine", owner);
  check(
    "editing a ready question → 'ready v1 + unpublished changes'",
    mine1.json.some((q: any) => q.id === qid && q.status === "ready" && q.latestVersion === 1 && q.hasUnpublishedChanges),
  );
  const room1Mid = await call("GET", `/rooms/${r1.json.roomId}`, candidate);
  check("unpublished edits don't reach an existing room", room1Mid.json.question.statement === v1Draft.statement);
  const p2 = await tab.publish();
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
  await tab.save({ ...v2Draft, title: "scratch edit" });
  const discarded = await tab.discard();
  check("discard draft → back to the ready version", discarded.status === 200 && discarded.json.draft === null && discarded.json.latest.version === 2);
  check("ready questions can't be deleted → 409", (await tab.remove()).status === 409);
  const throwaway = await call("POST", "/questions", owner, {});
  check(
    "never-ready question can be deleted → 204",
    (await call("DELETE", `/questions/${throwaway.json.id}`, owner, { revision: throwaway.json.revision })).status === 204,
  );

  // --- Two tabs editing the same question: optimistic concurrency ---------------------------------------
  // The question is ready (v2) with no draft. Both tabs open the editor.
  const tabA = editorTab(owner, () => qid);
  const tabB = editorTab(owner, () => qid);
  await tabA.load();
  await tabB.load();
  check("both tabs start from the same revision", tabA.revision > 0 && tabA.revision === tabB.revision);

  const aFirst = await tabA.save({ ...v2Draft, title: "Edited in tab A" });
  const bStale = await tabB.save({ ...v2Draft, title: "Edited in tab B" });
  check(
    "first edit wins; the other tab's save → 409 (nothing overwritten)",
    aFirst.status === 200 &&
      bStale.status === 409 &&
      bStale.json.conflict === "draft_changed" &&
      bStale.json.currentRevision === aFirst.json.revision &&
      (await call("GET", `/questions/${qid}`, owner)).json.draft.title === "Edited in tab A",
  );

  await tabB.load(); // tab B reloads and sees A's draft
  const aAgain = await tabA.save({ ...v2Draft, title: "Edited in tab A, twice" });
  const bPublish = await tabB.publish();
  check(
    "publishing a revision you haven't seen → 409, not published",
    aAgain.status === 200 && bPublish.status === 409 && (await call("GET", `/questions/${qid}`, owner)).json.latest.version === 2,
  );
  check("discarding a revision you haven't seen → 409", (await tabB.discard()).status === 409);

  await tabB.load();
  const [raceA, raceB] = await Promise.all([
    tabA.save({ ...v2Draft, title: "race A" }),
    tabB.save({ ...v2Draft, title: "race B" }),
  ]);
  check(
    "two simultaneous saves from the same revision → exactly one wins",
    [raceA.status, raceB.status].sort().join(",") === "200,409",
    `(${raceA.status}, ${raceB.status})`,
  );
  const winner = raceA.status === 200 ? tabA : tabB;
  check("the up-to-date tab can still publish", (await winner.publish()).json?.latest?.version === 3);

  // --- Regression: a draft is replaced while an old tab is still open (ABA) -----------------------------
  // A per-draft counter restarts at 1 for every new draft, so an old tab's revision could match a
  // DIFFERENT draft. The question-level revision never resets; each case below must be rejected.
  const titleNow = async () => (await call("GET", `/questions/${qid}`, owner)).json;
  const stale = editorTab(owner, () => qid);
  const fresh = editorTab(owner, () => qid);

  // Case 1: draft X is published, then a new draft Y is started; the old tab still holds X.
  await fresh.load();
  await fresh.save({ ...v2Draft, title: "draft X" });
  await stale.load(); // sees draft X
  await fresh.publish(); // X becomes a version
  await fresh.save({ ...v2Draft, title: "draft Y" }); // brand-new draft
  const c1save = await stale.save({ ...v2Draft, title: "stale overwrite" });
  const c1pub = await stale.publish();
  const c1dis = await stale.discard();
  const after1 = await titleNow();
  check(
    "replaced draft (after publish): old tab's save/publish/discard → 409",
    c1save.status === 409 && c1pub.status === 409 && c1dis.status === 409,
    `(${c1save.status}, ${c1pub.status}, ${c1dis.status})`,
  );
  check("…and the new draft is untouched, unpublished", after1.draft?.title === "draft Y" && after1.latest.version === 4);

  // Case 2: draft Y is discarded, then draft Z is started; the old tab still holds Y.
  await stale.load(); // sees draft Y
  await fresh.load();
  await fresh.discard();
  await fresh.save({ ...v2Draft, title: "draft Z" });
  const c2 = [await stale.save({ ...v2Draft, title: "stale" }), await stale.publish(), await stale.discard()];
  const after2 = await titleNow();
  check(
    "replaced draft (after discard): old tab's save/publish/discard → 409",
    c2.every((r) => r.status === 409) && after2.draft?.title === "draft Z",
  );

  // Case 3: the old tab opened the question when it had no draft; meanwhile a newer version was published.
  await fresh.load();
  await fresh.publish(); // Z → v5, no draft now
  await stale.load(); // no draft, ready v5
  await fresh.save({ ...v2Draft, title: "draft W" });
  await fresh.publish(); // v6, no draft again — same shape the old tab saw
  const c3 = await stale.save({ ...v2Draft, title: "edit of v5" });
  const after3 = await titleNow();
  check(
    "editing from a superseded ready version → 409 (no draft created)",
    c3.status === 409 && after3.draft === null && after3.latest.version === 6,
  );

  // The simplest stale cases: the open draft was published / discarded, nothing else happened.
  await fresh.load();
  await fresh.save({ ...v2Draft, title: "draft V" });
  await stale.load();
  await fresh.publish(); // v7
  check("old tab saves after its draft was published → 409", (await stale.save({ ...v2Draft, title: "x" })).status === 409);
  await fresh.load();
  await fresh.save({ ...v2Draft, title: "draft U" });
  await stale.load();
  await fresh.discard();
  const resurrect = await stale.save({ ...v2Draft, title: "resurrected" });
  check(
    "old tab saves after its draft was discarded → 409 (not resurrected)",
    resurrect.status === 409 && (await titleNow()).draft === null,
  );

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
