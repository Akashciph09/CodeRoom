/**
 * Multi-question rooms (ADR 0009) against the running stack (supabase, redis, api, worker).
 *   pnpm smoke   (runs smoke.ts, questions-smoke.ts, then this) — or: pnpm smoke:rooms
 *
 * Guarantees checked here:
 *  - the candidate never receives an unrevealed question (content or count) and can't submit to one;
 *  - questions are revealed only by the interviewer, strictly in order, idempotently — also under races;
 *  - every submission is graded against its own question's pinned version, enforced by the database;
 *  - interviewer notes stay private and can only link the same room's questions/submissions (ADR 0016);
 *  - evaluations: drafts any time, submit only after the end and only when complete, then locked (ADR 0017).
 */
import { randomUUID } from "node:crypto";
import { and, createDb, eq, evaluations, evaluationScores, interviewNotes, roomParticipants, roomQuestions, rooms, sql, submissions } from "@coderoom/db";
import { emptyDimensions } from "@coderoom/shared";
import { call, check, finish, QUESTION_ID, readyQuestion, roomQuestionIds, signUp, sleep, userIdOf } from "./lib.js";

const SUM = "a, b = map(int, input().split())\nprint(a + b)";
const PRODUCT = "a, b = map(int, input().split())\nprint(a * b)";
const DIFFERENCE = "a, b = map(int, input().split())\nprint(a - b)";

/** Drizzle wraps Postgres errors ("Failed query: …"); the constraint message is on `cause`. */
const dbError = (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message;

async function waitFor(id: string, token: string) {
  for (let i = 0; i < 80; i++) {
    const { json } = await call("GET", `/submissions/${id}`, token);
    if (json?.status === "completed" || json?.status === "failed") return json;
    await sleep(250);
  }
  throw new Error(`submission ${id} did not finish`);
}

const reveal = (token: string, roomId: string, rqId: string) =>
  call("POST", `/rooms/${roomId}/questions/${rqId}/reveal`, token);

async function main() {
  const interviewer = await signUp("mq-interviewer");
  const candidate = await signUp("mq-candidate");
  const outsider = await signUp("mq-outsider");

  const product = await readyQuestion(interviewer, "Multiply two numbers", "SECRET-PRODUCT-STATEMENT: print a * b.", [
    ["2 3\n", "6"],
    ["4 5\n", "20"],
  ]);
  const difference = await readyQuestion(interviewer, "Subtract two numbers", "SECRET-DIFFERENCE-STATEMENT: print a - b.", [
    ["5 3\n", "2"],
    ["9 4\n", "5"],
  ]);
  const others = await readyQuestion(outsider, "Someone else's", "not yours", [["1 1\n", "2"]]);

  // --- Creating rooms ------------------------------------------------------------------------------
  const create = (token: string, questionIds: unknown) => call("POST", "/rooms", token, { questionIds });
  check("no questions → 400", (await create(interviewer, [])).status === 400);
  check("more than 5 questions → 400", (await create(interviewer, Array.from({ length: 6 }, () => randomUUID()))).status === 400);
  check("same question twice → 400", (await create(interviewer, [product, product])).status === 400);
  check("someone else's question in the list → 404", (await create(interviewer, [QUESTION_ID, others])).status === 404);

  const created = await create(interviewer, [QUESTION_ID, product, difference]);
  check("interviewer creates a 3-question room", created.status === 201);
  const roomId = created.json.roomId as string;
  await call("POST", "/rooms/join", candidate, { inviteCode: created.json.inviteCode });
  const [rq1, rq2, rq3] = (await roomQuestionIds(roomId, interviewer)) as [string, string, string];

  const ivRoom = await call("GET", `/rooms/${roomId}`, interviewer);
  check(
    "interviewer sees all questions in order, only Q1 revealed",
    ivRoom.json.questions.map((q: any) => `${q.position}:${q.revealed}`).join(",") === "1:true,2:false,3:false" &&
      ivRoom.json.questions[1].question.title === "Multiply two numbers",
  );

  // --- Unrevealed questions don't exist for the candidate -------------------------------------------
  const cdRoom = await call("GET", `/rooms/${roomId}`, candidate);
  const cdJson = JSON.stringify(cdRoom.json);
  check(
    "candidate gets only Q1 — no title, statement, tests or ids of later questions",
    cdRoom.json.questions.length === 1 &&
      cdRoom.json.questions[0].id === rq1 &&
      !cdJson.includes("Multiply") &&
      !cdJson.includes("SECRET-PRODUCT") &&
      !cdJson.includes("SECRET-DIFFERENCE") &&
      !cdJson.includes(rq2) &&
      !cdJson.includes(rq3),
  );
  const submit = (token: string, rqId: string, code: string, mode = "submit", key?: string) =>
    call(
      "POST",
      "/submissions",
      token,
      { roomId, roomQuestionId: rqId, language: "python", mode, code },
      undefined,
      key ? { "idempotency-key": key } : {},
    );
  check("submitting to an unrevealed question → 404 (same as a nonexistent one)", (await submit(candidate, rq2, PRODUCT)).status === 404);
  check("submitting to a made-up question id → 404", (await submit(candidate, randomUUID(), PRODUCT)).status === 404);

  // --- Revealing -------------------------------------------------------------------------------------
  check("candidate can't reveal → 403", (await reveal(candidate, roomId, rq2)).status === 403);
  check("outsider can't reveal → 403", (await reveal(outsider, roomId, rq2)).status === 403);
  check("can't skip ahead: revealing Q3 before Q2 → 409", (await reveal(interviewer, roomId, rq3)).status === 409);
  check("interviewer reveals Q2", (await reveal(interviewer, roomId, rq2)).status === 200);
  check("revealing Q2 again is a no-op → 200", (await reveal(interviewer, roomId, rq2)).status === 200);

  const cdRoom2 = await call("GET", `/rooms/${roomId}`, candidate);
  check(
    "candidate now sees Q1 and Q2, still not Q3",
    cdRoom2.json.questions.map((q: any) => q.id).join() === [rq1, rq2].join() &&
      !JSON.stringify(cdRoom2.json).includes("SECRET-DIFFERENCE"),
  );

  // --- Each question is graded against its own pinned version -----------------------------------
  const onQ2 = await waitFor((await submit(candidate, rq2, PRODUCT)).json.submissionId, candidate);
  check("product code on Q2 → accepted (Q2's tests)", onQ2.overall === "accepted" && onQ2.roomQuestionId === rq2);
  const sumOnQ2 = await waitFor((await submit(candidate, rq2, SUM)).json.submissionId, candidate);
  check("sum code on Q2 → wrong answer", sumOnQ2.overall === "wrong_answer");
  const onQ1 = await waitFor((await submit(candidate, rq1, SUM)).json.submissionId, candidate);
  check("sum code on Q1 → accepted (Q1's tests)", onQ1.overall === "accepted" && onQ1.roomQuestionId === rq1);

  const key = randomUUID();
  const keyed = await submit(candidate, rq1, SUM, "run", key);
  check(
    "same idempotency key for a different question → 422",
    keyed.status === 202 && (await submit(candidate, rq2, SUM, "run", key)).status === 422,
  );

  const history = await call("GET", `/rooms/${roomId}/submissions`, interviewer);
  check(
    "history tags every submission with its question",
    history.json.length === 4 && history.json.every((s: any) => [rq1, rq2].includes(s.roomQuestionId)),
  );

  // --- The database refuses a submission whose version isn't its room question's -----------------
  const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
  const [q1Row] = await db.select().from(roomQuestions).where(eq(roomQuestions.id, rq1));
  let fkError = "";
  try {
    await db.insert(submissions).values({
      roomId,
      roomQuestionId: rq2, // Q2…
      questionVersionId: q1Row!.questionVersionId, // …graded with Q1's version
      userId: userIdOf(candidate),
      language: "python",
      mode: "run",
      code: "print(1)",
    });
  } catch (e) {
    fkError = dbError(e as Error & { cause?: { message?: string } });
  }
  check("DB rejects a submission graded against another question's version", fkError.includes("submissions_room_question_fk"), `(${fkError.slice(0, 60)})`);

  // --- Concurrent reveals never break the order -------------------------------------------------------
  let orderedEveryTime = true;
  for (let i = 0; i < 8; i++) {
    const race = await create(interviewer, [QUESTION_ID, product, difference]);
    const [, r2, r3] = (await roomQuestionIds(race.json.roomId, interviewer)) as [string, string, string];
    await Promise.all([reveal(interviewer, race.json.roomId, r3), reveal(interviewer, race.json.roomId, r2)]);
    const states = (await call("GET", `/rooms/${race.json.roomId}`, interviewer)).json.questions.map((q: any) => q.revealed);
    // Revealed questions must always be a prefix: never Q3 without Q2.
    if (states[2] && !states[1]) orderedEveryTime = false;
  }
  await close();
  check("racing reveals of Q2 and Q3 never reveal Q3 alone (8 rounds)", orderedEveryTime);

  // --- A reveal can't slip in after the session ends ------------------------------------------------
  // Deterministic: hold the room row lock exactly like the close UPDATE does, fire a reveal while it's
  // held, then commit the close. The reveal must wait for the lock and then see the room closed.
  {
    const raceRoom = await create(interviewer, [QUESTION_ID, product]);
    const raceId = raceRoom.json.roomId as string;
    const [, raceQ2] = (await roomQuestionIds(raceId, interviewer)) as [string, string];
    const { db: lockDb, close: closeLockDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    let revealSettledWhileLocked = false;
    let revealStatus = 0;
    await lockDb.transaction(async (tx) => {
      await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, raceId)).for("update");
      const pending = reveal(interviewer, raceId, raceQ2).then((r) => (revealStatus = r.status));
      await sleep(600);
      revealSettledWhileLocked = revealStatus !== 0;
      await tx.update(rooms).set({ status: "closed" }).where(eq(rooms.id, raceId));
      // Commit happens when this callback returns; the reveal is still waiting.
      void pending;
    });
    for (let i = 0; i < 40 && revealStatus === 0; i++) await sleep(50);
    const [q2Row] = await lockDb.select({ revealedAt: roomQuestions.revealedAt }).from(roomQuestions).where(eq(roomQuestions.id, raceQ2));
    await closeLockDb();
    check(
      "reveal racing the session's end waits for it, then is refused (400) and nothing is revealed",
      !revealSettledWhileLocked && revealStatus === 400 && q2Row?.revealedAt === null,
      `(settled while locked: ${revealSettledWhileLocked}, status ${revealStatus}, revealed: ${q2Row?.revealedAt !== null})`,
    );
  }

  // Same for submissions: one fired while the room row is held by a closing transaction must wait for
  // the close and be refused — no submission row, nothing queued for the sandbox.
  {
    const subRoom = await create(interviewer, [QUESTION_ID]);
    const subRoomId = subRoom.json.roomId as string;
    const lateCandidate = await signUp("mq-late-candidate");
    await call("POST", "/rooms/join", lateCandidate, { inviteCode: subRoom.json.inviteCode });
    const [subQ1] = (await roomQuestionIds(subRoomId, interviewer)) as [string];
    const { db: lockDb, close: closeLockDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    let settledWhileLocked = false;
    let submitStatus = 0;
    await lockDb.transaction(async (tx) => {
      await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, subRoomId)).for("update");
      void call("POST", "/submissions", lateCandidate, {
        roomId: subRoomId, roomQuestionId: subQ1, language: "python", mode: "run", code: SUM,
      }).then((r) => (submitStatus = r.status));
      await sleep(600);
      settledWhileLocked = submitStatus !== 0;
      await tx.update(rooms).set({ status: "closed" }).where(eq(rooms.id, subRoomId));
    });
    for (let i = 0; i < 40 && submitStatus === 0; i++) await sleep(50);
    const rows = await lockDb.select({ id: submissions.id }).from(submissions).where(eq(submissions.roomId, subRoomId));
    await closeLockDb();
    check(
      "submission racing the session's end waits for it, then is refused (400) and nothing is stored",
      !settledWhileLocked && submitStatus === 400 && rows.length === 0,
      `(settled while locked: ${settledWhileLocked}, status ${submitStatus}, rows ${rows.length})`,
    );
  }

  // Many real close/reveal races: whatever wins, a refused reveal never leaves a revealed question,
  // and a successful one always happened before the close.
  let raceConsistent = true;
  for (let i = 0; i < 8; i++) {
    const r = await create(interviewer, [QUESTION_ID, product]);
    const id = r.json.roomId as string;
    const [, q2] = (await roomQuestionIds(id, interviewer)) as [string, string];
    const [revealed] = await Promise.all([reveal(interviewer, id, q2), call("POST", `/rooms/${id}/close`, interviewer)]);
    const after = (await call("GET", `/rooms/${id}`, interviewer)).json;
    const isRevealed = after.questions[1].revealed as boolean;
    if (after.status !== "closed" || (revealed.status === 200) !== isRevealed || ![200, 400].includes(revealed.status)) {
      raceConsistent = false;
    }
  }
  check("concurrent close + reveal (8 rounds): the reveal either fully happens first or is refused", raceConsistent);

  // --- Custom test cases (ADR 0010): run-only, separate results, visible to both, never graded -------
  {
    const ccRoom = await create(interviewer, [QUESTION_ID]);
    const ccId = ccRoom.json.roomId as string;
    const ccCandidate = await signUp("mq-cc-candidate");
    await call("POST", "/rooms/join", ccCandidate, { inviteCode: ccRoom.json.inviteCode });
    const [ccQ] = (await roomQuestionIds(ccId, interviewer)) as [string];
    const runWith = (customCases: unknown, mode = "run", code = SUM, key?: string) =>
      call("POST", "/submissions", ccCandidate, { roomId: ccId, roomQuestionId: ccQ, language: "python", mode, code, customCases }, undefined, key ? { "idempotency-key": key } : {});

    const cases = [
      { input: "2 3\n", expectedOutput: "5" }, // matches
      { input: "-5 5\n" }, // no expected: just shows output
      { input: "1 1\n", expectedOutput: "3" }, // deliberately wrong expectation
    ];
    const ran = await runWith(cases);
    const done = await waitFor(ran.json.submissionId, ccCandidate);
    check(
      "custom cases run with Run: checked ones are judged, unchecked ones just show output",
      done.customResults?.map((c: any) => `${c.verdict}:${(c.stdout ?? "").trim()}`).join() === "accepted:5,accepted:0,wrong_answer:2",
      `(${JSON.stringify(done.customResults?.map((c: any) => c.verdict))})`,
    );
    check("…and never change the verdict (graded on the question's tests only)", done.overall === "accepted");
    const ivView = await call("GET", `/submissions/${ran.json.submissionId}`, interviewer);
    check(
      "the interviewer sees the same custom cases and outputs",
      ivView.json.customResults?.length === 3 && ivView.json.customResults[1].input === "-5 5\n",
    );
    const history = await call("GET", `/rooms/${ccId}/submissions`, ccCandidate);
    check("history includes custom results", history.json[0]?.customResults?.length === 3);

    check("custom cases with Submit → 400", (await runWith([{ input: "1 2\n" }], "submit")).status === 400);
    check("more than 10 custom cases → 400", (await runWith(Array.from({ length: 11 }, () => ({ input: "1 1\n" })))).status === 400);
    check("a custom case over 10 KB → 400", (await runWith([{ input: "1".repeat(10_001) }])).status === 400);
    const ccKey = randomUUID();
    await runWith([{ input: "1 2\n" }], "run", SUM, ccKey);
    check("same idempotency key with different custom cases → 422", (await runWith([{ input: "9 9\n" }], "run", SUM, ccKey)).status === 422);

    // --- Interview timer fields ---------------------------------------------------------------------
    const open = (await call("GET", `/rooms/${ccId}`, interviewer)).json;
    check(
      "room view carries createdAt and the server's time, no closedAt while open",
      Date.parse(open.createdAt) <= Date.parse(open.serverTime) && open.closedAt === undefined,
    );
    await call("POST", `/rooms/${ccId}/close`, interviewer);
    const closed1 = (await call("GET", `/rooms/${ccId}`, interviewer)).json.closedAt;
    await sleep(1100);
    await call("POST", `/rooms/${ccId}/close`, interviewer);
    const closed2 = (await call("GET", `/rooms/${ccId}`, interviewer)).json.closedAt;
    check("ending the session sets closedAt once (closing again keeps it)", !!closed1 && closed1 === closed2);
  }

  // --- Review + test score (ADR 0011) --------------------------------------------------------------
  {
    check("points must match the questions → 400", (await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID, product], questionPoints: [50] })).status === 400);
    check("points outside 1–100 → 400", (await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID], questionPoints: [0] })).status === 400);
    for (const questionPoints of [[40, 50], [60, 50]]) {
      const rejected = await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID, product], questionPoints });
      check(`custom points totaling ${questionPoints[0]! + questionPoints[1]!} are rejected → 400`,
        rejected.status === 400 && rejected.json?.issues?.some((issue: { message: string }) => issue.message === "Question points must add up to 100"));
    }

    const rv = await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID, product, difference], questionPoints: [20, 30, 50] });
    const rvId = rv.json.roomId as string;
    const alice = await signUp("rv-alice");
    await call("POST", "/rooms/join", alice, { inviteCode: rv.json.inviteCode });
    const [rq1, rq2, rq3] = (await roomQuestionIds(rvId, interviewer)) as [string, string, string];
    await reveal(interviewer, rvId, rq2); // Q3 (50 points) is never revealed
    // Bob interviews in his own room with the same questions and points (one candidate per room, ADR 0012).
    const rvBob = await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID, product, difference], questionPoints: [20, 30, 50] });
    const bob = await signUp("rv-bob");
    await call("POST", "/rooms/join", bob, { inviteCode: rvBob.json.inviteCode });
    const [, bobQ2] = (await roomQuestionIds(rvBob.json.roomId, interviewer)) as [string, string, string];
    await reveal(interviewer, rvBob.json.roomId, bobQ2);

    const submitAs = async (token: string, rqId: string, code: string, mode = "submit", room = rvId) => {
      const r = await call("POST", "/submissions", token, { roomId: room, roomQuestionId: rqId, language: "python", mode, code });
      return waitFor(r.json.submissionId, token);
    };
    // Alice: Q1 wrong (0/4) → right (4/4) → broken again (0/4); a Run on Q2; Q2 submitted wrong (0/2).
    await submitAs(alice, rq1, DIFFERENCE);
    await submitAs(alice, rq1, SUM);
    await submitAs(alice, rq1, PRODUCT);
    await submitAs(alice, rq2, PRODUCT, "run");
    await submitAs(alice, rq2, SUM);
    // Bob: only Q2, correct (2/2).
    await submitAs(bob, bobQ2, PRODUCT, "submit", rvBob.json.roomId);

    check("a candidate can't open the review → 403", (await call("GET", `/rooms/${rvId}/review`, alice)).status === 403);
    check("an outsider can't open the review → 403", (await call("GET", `/rooms/${rvId}/review`, outsider)).status === 403);
    const review = await call("GET", `/rooms/${rvId}/review`, interviewer);
    check("the interviewer gets the review", review.status === 200);
    const byName = (prefix: string) => review.json.candidates.find((c: any) => c.name.startsWith(prefix));
    const a = byName("rv-alice");
    const b = (await call("GET", `/rooms/${rvBob.json.roomId}/review`, interviewer)).json.candidates[0];
    const q = (c: any, id: string) => c.questions.find((x: any) => x.roomQuestionId === id);
    check(
      "test score uses the best Submit (4/4), not the last (0/4); Run isn't counted",
      q(a, rq1).best?.passed === 4 && q(a, rq1).best?.total === 4 && q(a, rq2).best?.passed === 0,
      `(Q1 ${q(a, rq1).best?.passed}/${q(a, rq1).best?.total}, Q2 ${q(a, rq2).best?.passed}/${q(a, rq2).best?.total})`,
    );
    check(
      "hidden tests count: Q1's best Submit is judged on all 4 tests (2 hidden)",
      a.submissions.find((s: any) => s.submissionId === q(a, rq1).best?.submissionId)?.hiddenTotal === 2,
    );
    check(
      "weighted and normalized over revealed questions only: Alice 40, Bob 60 (Q3 not counted)",
      a.score === 40 && b.score === 60 && q(a, rq3).counted === false,
      `(Alice ${a.score}, Bob ${b.score})`,
    );
    check("the review shows the room's one candidate and their whole timeline", review.json.candidates.length === 1 && a.submissions.length === 5 && b.submissions.length === 1);
    // --- Room list (ADR 0013): interviewer rows carry candidate name and email — nothing else ---------
    const ivList = (await call("GET", "/rooms", interviewer)).json as any[];
    const aliceRow = ivList.find((r) => r.roomId === rvId);
    check(
      "interviewer's room list shows the candidate's name and email, and no score",
      aliceRow?.candidates?.length === 1 &&
        aliceRow.candidates[0].name.startsWith("rv-alice") &&
        /^rv-alice-.*@example\.test$/.test(aliceRow.candidates[0].email) &&
        JSON.stringify(Object.keys(aliceRow.candidates[0]).sort()) === '["email","name"]',
      `(${JSON.stringify(aliceRow?.candidates)})`,
    );
    const empty = await create(interviewer, [QUESTION_ID]);
    const emptyRow = ((await call("GET", "/rooms", interviewer)).json as any[]).find((r) => r.roomId === empty.json.roomId);
    check("a room nobody joined lists no candidates", Array.isArray(emptyRow?.candidates) && emptyRow.candidates.length === 0);
    const aliceList = await call("GET", "/rooms", alice);
    const aliceJson = JSON.stringify(aliceList.json);
    check(
      "a candidate's own room list carries no candidate details (no names or emails)",
      aliceList.status === 200 &&
        (aliceList.json as any[]).some((r) => r.roomId === rvId) &&
        (aliceList.json as any[]).every((r) => r.candidates === undefined) &&
        !aliceJson.includes("@example.test"),
    );

    // A room from before one-candidate-per-room (ADR 0012): both candidates, in join order.
    const legacyRoom = await create(interviewer, [QUESTION_ID]);
    const legacyFirst = await signUp("legacy-first");
    await call("POST", "/rooms/join", legacyFirst, { inviteCode: legacyRoom.json.inviteCode });
    const legacySecond = await signUp("legacy-second");
    const { db: legacyDb, close: closeLegacyDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    await legacyDb.insert(roomParticipants).values({
      roomId: legacyRoom.json.roomId,
      userId: userIdOf(legacySecond),
      role: "candidate",
      legacyExtra: true, // exactly how the ADR 0012 migration kept pre-existing extra candidates
    });
    await closeLegacyDb();
    const legacyRow = ((await call("GET", "/rooms", interviewer)).json as any[]).find((r) => r.roomId === legacyRoom.json.roomId);
    check(
      "a legacy room lists every candidate, in join order",
      legacyRow?.candidates?.map((c: any) => c.name.split("-")[1]).join() === "first,second",
      `(${JSON.stringify(legacyRow?.candidates)})`,
    );

    const rq3View = review.json.questions.find((x: any) => x.id === rq3);
    check(
      "reveal windows for revealed questions only",
      review.json.questions.find((x: any) => x.id === rq1).revealWindowMs >= 0 && rq3View.revealWindowMs === undefined && rq3View.points === 50,
    );
  }

  // --- Room names (ADR 0014): optional, trimmed, ≤ 80, interviewer-only -----------------------------
  {
    const named = await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID], name: "  Backend interview  " });
    const namedId = named.json.roomId as string;
    const asIv = (await call("GET", `/rooms/${namedId}`, interviewer)).json;
    check("a room can be created with a name (trimmed)", named.status === 201 && asIv.name === "Backend interview", `(${JSON.stringify(asIv.name)})`);
    const blank = await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID], name: "   " });
    check("a blank name means no name", blank.status === 201 && (await call("GET", `/rooms/${blank.json.roomId}`, interviewer)).json.name === undefined);
    check("a name over 80 characters → 400", (await call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID], name: "x".repeat(81) })).status === 400);

    const nameCandidate = await signUp("name-candidate");
    await call("POST", "/rooms/join", nameCandidate, { inviteCode: named.json.inviteCode });
    const asCd = await call("GET", `/rooms/${namedId}`, nameCandidate);
    const cdList = await call("GET", "/rooms", nameCandidate);
    check(
      "the candidate never receives the name (room view and room list)",
      asCd.status === 200 && asCd.json.name === undefined && !JSON.stringify(asCd.json).includes("Backend interview") &&
        !JSON.stringify(cdList.json).includes("Backend interview"),
    );
    const ivRow = ((await call("GET", "/rooms", interviewer)).json as any[]).find((r) => r.roomId === namedId);
    check("the interviewer's room list shows the name", ivRow?.name === "Backend interview");
    check("the candidate can't rename → 403", (await call("PATCH", `/rooms/${namedId}`, nameCandidate, { name: "Hacked" })).status === 403);
    check("an outsider can't rename → 403", (await call("PATCH", `/rooms/${namedId}`, outsider, { name: "Hacked" })).status === 403);
    const renamed = await call("PATCH", `/rooms/${namedId}`, interviewer, { name: "SRE interview" });
    check("the interviewer renames it", renamed.status === 200 && (await call("GET", `/rooms/${namedId}`, interviewer)).json.name === "SRE interview");
    check("rename over 80 characters → 400", (await call("PATCH", `/rooms/${namedId}`, interviewer, { name: "y".repeat(81) })).status === 400);
    await call("POST", `/rooms/${namedId}/close`, interviewer);
    const cleared = await call("PATCH", `/rooms/${namedId}`, interviewer, { name: "" });
    check("…clears it, also after the session ended", cleared.status === 200 && (await call("GET", `/rooms/${namedId}`, interviewer)).json.name === undefined);
    check("the review shows the name when set", (await call("PATCH", `/rooms/${namedId}`, interviewer, { name: "Final name" })).status === 200 &&
      (await call("GET", `/rooms/${namedId}/review`, interviewer)).json.name === "Final name");

    const { db: nameDb, close: closeNameDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    let dbRefused = "";
    try {
      await nameDb.update(rooms).set({ name: "   " }).where(eq(rooms.id, namedId));
    } catch (e) {
      dbRefused = dbError(e as Error & { cause?: { message?: string } });
    }
    await closeNameDb();
    check("the database itself refuses a blank name", dbRefused.includes("rooms_name_length"), `(${dbRefused.slice(0, 60)})`);
  }

  // --- One interviewer, one candidate per room (ADR 0012) --------------------------------------------
  {
    const solo = await create(interviewer, [QUESTION_ID]);
    const soloId = solo.json.roomId as string;
    const first = await signUp("solo-first");
    const second = await signUp("solo-second");
    const join = (token: string, code = solo.json.inviteCode) => call("POST", "/rooms/join", token, { inviteCode: code });
    check("the first person with the link becomes the candidate", (await join(first)).status === 200);
    check("the candidate can rejoin (another device, a reload) → 200", (await join(first)).status === 200);
    const refused = await join(second);
    check("anyone else with the link → 409 room_full", refused.status === 409 && refused.json?.conflict === "room_full", `(${refused.status} ${JSON.stringify(refused.json)})`);
    const [soloQ] = (await roomQuestionIds(soloId, interviewer)) as [string];
    check(
      "…and gets no access: room 403, submit 403, review 403",
      (await call("GET", `/rooms/${soloId}`, second)).status === 403 &&
        (await call("POST", "/submissions", second, { roomId: soloId, roomQuestionId: soloQ, language: "python", mode: "run", code: "print(1)" })).status === 403 &&
        (await call("GET", `/rooms/${soloId}/review`, second)).status === 403,
    );
    // The interviewer opening their own link is sent to the room as interviewer; the seat isn't touched.
    const own = await create(interviewer, [QUESTION_ID]);
    const ownJoin = await join(interviewer, own.json.inviteCode);
    const seat = await join(first, own.json.inviteCode);
    check(
      "the interviewer's own link → 200 as interviewer, and the candidate seat stays free",
      ownJoin.status === 200 && ownJoin.json.role === "interviewer" && ownJoin.json.roomId === own.json.roomId && seat.status === 200,
      `(${ownJoin.status} ${ownJoin.json?.role}; then candidate ${seat.status})`,
    );

    // Two people opening the link at the same instant: the database lets exactly one in, every time.
    const { db: raceDb, close: closeRaceDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    let exactlyOne = true;
    for (let i = 0; i < 10; i++) {
      const r = await create(interviewer, [QUESTION_ID]);
      const [x, y] = await Promise.all([signUp("race-x"), signUp("race-y")]);
      const statuses = (await Promise.all([join(x, r.json.inviteCode), join(y, r.json.inviteCode)])).map((res) => res.status).sort();
      const seats = await raceDb
        .select({ userId: roomParticipants.userId })
        .from(roomParticipants)
        .where(and(eq(roomParticipants.roomId, r.json.roomId), eq(roomParticipants.role, "candidate")));
      if (statuses.join() !== "200,409" || seats.length !== 1) exactlyOne = false;
    }
    await closeRaceDb();
    check("simultaneous joins (10 rounds): exactly one candidate, the other gets 409", exactlyOne);
  }

  // --- Private interviewer notes (ADR 0016) ----------------------------------------------------------
  {
    const nRoom = await create(interviewer, [QUESTION_ID, product]);
    const nId = nRoom.json.roomId as string;
    const nCandidate = await signUp("notes-candidate");
    await call("POST", "/rooms/join", nCandidate, { inviteCode: nRoom.json.inviteCode });
    const [nq1, nq2] = (await roomQuestionIds(nId, interviewer)) as [string, string];
    const run = await call("POST", "/submissions", nCandidate, { roomId: nId, roomQuestionId: nq1, language: "python", mode: "run", code: SUM });
    await waitFor(run.json.submissionId, nCandidate);
    // Another room, with its own question and submission, to try cross-room links.
    const other = await create(interviewer, [QUESTION_ID]);
    const otherId = other.json.roomId as string;
    const otherCandidate = await signUp("notes-other");
    await call("POST", "/rooms/join", otherCandidate, { inviteCode: other.json.inviteCode });
    const [otherQ] = (await roomQuestionIds(otherId, interviewer)) as [string];
    const otherRun = await call("POST", "/submissions", otherCandidate, { roomId: otherId, roomQuestionId: otherQ, language: "python", mode: "run", code: SUM });

    const notes = (token: string) => call("GET", `/rooms/${nId}/notes`, token);
    const add = (token: string, body: unknown) => call("POST", `/rooms/${nId}/notes`, token, body);
    const SECRET = "SECRET-NOTE: hinted at the two-pointer approach";

    const general = await add(interviewer, { body: `  ${SECRET}  ` });
    check(
      "the interviewer adds a general note (trimmed, no links, author's name, created = edited)",
      general.status === 201 && general.json.body === SECRET && general.json.roomQuestionId === null &&
        general.json.submissionId === null && general.json.mine === true && typeof general.json.authorName === "string" &&
        general.json.createdAt === general.json.updatedAt,
      `(${general.status} ${JSON.stringify(general.json)})`,
    );
    const onQuestion = await add(interviewer, { body: "Asked about edge cases", roomQuestionId: nq2 });
    check("…a note on a question (also one not revealed yet)", onQuestion.status === 201 && onQuestion.json.roomQuestionId === nq2);
    const onSubmission = await add(interviewer, { body: "First run passed", submissionId: run.json.submissionId });
    check(
      "…a note linked to a submission takes that submission's question",
      onSubmission.status === 201 && onSubmission.json.submissionId === run.json.submissionId && onSubmission.json.roomQuestionId === nq1,
    );
    check(
      "a submission with a different question → 400",
      (await add(interviewer, { body: "x", submissionId: run.json.submissionId, roomQuestionId: nq2 })).status === 400,
    );
    check("another room's question → 404", (await add(interviewer, { body: "x", roomQuestionId: otherQ })).status === 404);
    check("another room's submission → 404", (await add(interviewer, { body: "x", submissionId: otherRun.json.submissionId })).status === 404);
    check("an empty / whitespace note → 400", (await add(interviewer, { body: " \n\t " })).status === 400);
    check("over 5000 characters → 400; exactly 5000 is fine", (await add(interviewer, { body: "x".repeat(5001) })).status === 400 &&
      (await add(interviewer, { body: "😀".repeat(5000) })).status === 201);
    check("unknown fields → 400", (await add(interviewer, { body: "x", authorId: userIdOf(nCandidate) })).status === 400);

    // Privacy: candidate and outsider can't list, add, edit or delete; nothing the candidate can fetch has the text.
    const path = `/rooms/${nId}/notes/${general.json.id}`;
    for (const [who, token] of [["candidate", nCandidate], ["outsider", outsider]] as const) {
      const statuses = [
        (await notes(token)).status,
        (await add(token, { body: "mine" })).status,
        (await call("PATCH", path, token, { body: "changed" })).status,
        (await call("DELETE", path, token)).status,
      ];
      check(`the ${who} can't list/add/edit/delete notes → 403`, statuses.every((st) => st === 403), `(${statuses.join(",")})`);
    }
    const candidateSees = JSON.stringify([
      (await call("GET", `/rooms/${nId}`, nCandidate)).json,
      (await call("GET", `/rooms/${nId}/submissions`, nCandidate)).json,
      (await call("GET", `/submissions/${run.json.submissionId}`, nCandidate)).json,
      (await call("GET", "/rooms", nCandidate)).json,
    ]);
    check("nothing the candidate can fetch contains a note", !candidateSees.includes("SECRET-NOTE") && !candidateSees.includes("Asked about edge cases"));

    // Another interviewer's note id, or a note id of another room, is "not found" here.
    const otherNote = await call("POST", `/rooms/${otherId}/notes`, interviewer, { body: "other room" });
    check(
      "a note of another room can't be edited or deleted through this room → 404",
      (await call("PATCH", `/rooms/${nId}/notes/${otherNote.json.id}`, interviewer, { body: "moved?" })).status === 404 &&
        (await call("DELETE", `/rooms/${nId}/notes/${otherNote.json.id}`, interviewer)).status === 404,
    );

    // Edit: text + links replaced, updated_at moves, created_at doesn't.
    await sleep(20);
    const edited = await call("PATCH", path, interviewer, { body: "Edited: hinted at two pointers", roomQuestionId: nq1 });
    check(
      "the author edits a note (text and link); edited time recorded, created time kept",
      edited.status === 200 && edited.json.body === "Edited: hinted at two pointers" && edited.json.roomQuestionId === nq1 &&
        edited.json.createdAt === general.json.createdAt && Date.parse(edited.json.updatedAt) > Date.parse(general.json.updatedAt),
    );
    check("editing to another room's submission → 404", (await call("PATCH", path, interviewer, { body: "x", submissionId: otherRun.json.submissionId })).status === 404);

    // The database refuses cross-room links itself (composite foreign keys), whatever the API does.
    const { db: notesDb, close: closeNotesDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    const refusal = async (values: Partial<typeof interviewNotes.$inferInsert>) => {
      try {
        await notesDb.insert(interviewNotes).values({ roomId: nId, authorId: userIdOf(interviewer), body: "direct", ...values });
        return "";
      } catch (e) {
        return dbError(e as Error & { cause?: { message?: string } });
      }
    };
    const qRefused = await refusal({ roomQuestionId: otherQ });
    const sRefused = await refusal({ submissionId: otherRun.json.submissionId });
    const blank = await refusal({ body: "   " });
    // Rooms have one interviewer today (ADR 0012); plant a note by someone else to check author-only edits.
    const [foreign] = await notesDb
      .insert(interviewNotes)
      .values({ roomId: nId, authorId: userIdOf(outsider), body: "another author's note" })
      .returning({ id: interviewNotes.id });
    await closeNotesDb();
    const foreignPath = `/rooms/${nId}/notes/${foreign!.id}`;
    const listed = ((await notes(interviewer)).json as { id: string; mine: boolean }[]).find((n) => n.id === foreign!.id);
    check(
      "only the author edits or deletes: another author's note → 403 (listed with mine=false)",
      listed?.mine === false &&
        (await call("PATCH", foreignPath, interviewer, { body: "rewritten" })).status === 403 &&
        (await call("DELETE", foreignPath, interviewer)).status === 403,
    );
    check("the database refuses another room's question", qRefused.includes("interview_notes_question_fk"), `(${qRefused.slice(0, 60)})`);
    check("the database refuses another room's submission", sRefused.includes("interview_notes_submission_fk"), `(${sRefused.slice(0, 60)})`);
    check("the database refuses a blank note", blank.includes("interview_notes_body_length"), `(${blank.slice(0, 60)})`);

    // PR #15 review: deleting a candidate's account (Supabase Auth) cascades to their submissions. A note
    // linking one of them must not block that: the note stays (it's the interviewer's), keeps its room
    // and question, and only loses the submission link.
    {
      const gone = await signUp("notes-deleted-candidate");
      const goneRoom = await create(interviewer, [QUESTION_ID]);
      await call("POST", "/rooms/join", gone, { inviteCode: goneRoom.json.inviteCode });
      const [goneQ] = (await roomQuestionIds(goneRoom.json.roomId, interviewer)) as [string];
      const goneRun = await call("POST", "/submissions", gone, { roomId: goneRoom.json.roomId, roomQuestionId: goneQ, language: "python", mode: "run", code: SUM });
      await waitFor(goneRun.json.submissionId, gone);
      const linkedNote = await call("POST", `/rooms/${goneRoom.json.roomId}/notes`, interviewer, { body: "Linked to a run", submissionId: goneRun.json.submissionId });
      const { db: authDb, close: closeAuthDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
      let deleteError = "";
      try {
        await authDb.execute(sql`delete from auth.users where id = ${userIdOf(gone)}`);
      } catch (e) {
        deleteError = dbError(e as Error & { cause?: { message?: string } });
      }
      const [kept] = await authDb.select().from(interviewNotes).where(eq(interviewNotes.id, linkedNote.json.id));
      const [run] = await authDb.select({ id: submissions.id }).from(submissions).where(eq(submissions.id, goneRun.json.submissionId));
      await closeAuthDb();
      check("deleting a candidate whose run is linked from a note succeeds", deleteError === "" && run === undefined, `(${deleteError.slice(0, 80)})`);
      check(
        "…the note stays, with its room and question, and only loses the run link",
        kept?.roomId === goneRoom.json.roomId && kept?.roomQuestionId === goneQ && kept?.submissionId === null && kept?.body === "Linked to a run",
        `(${JSON.stringify(kept && { roomId: kept.roomId === goneRoom.json.roomId, q: kept.roomQuestionId === goneQ, sub: kept.submissionId })})`,
      );
    }

    // After the session ends: still writable; the review carries the notes, oldest first.
    await call("POST", `/rooms/${nId}/close`, interviewer);
    const late = await add(interviewer, { body: "Wrap-up: strong on testing" });
    check("notes can be added after the session ended", late.status === 201);
    check("…and deleted (204), then gone", (await call("DELETE", `/rooms/${nId}/notes/${onQuestion.json.id}`, interviewer)).status === 204 &&
      !(await notes(interviewer)).json.some((n: { id: string }) => n.id === onQuestion.json.id));
    const review = await call("GET", `/rooms/${nId}/review`, interviewer);
    const reviewNotes = (review.json.notes ?? []) as { id: string; body: string }[];
    check(
      "the review includes the room's notes, oldest first (and not other rooms')",
      review.status === 200 && reviewNotes[0]?.id === general.json.id && reviewNotes.at(-1)?.id === late.json.id &&
        !reviewNotes.some((n) => n.body === "other room"),
      `(${reviewNotes.map((n) => n.body.slice(0, 12)).join(" | ")})`,
    );
  }

  // --- Structured evaluation (ADR 0017) ---------------------------------------------------------------
  {
    const eRoom = await create(interviewer, [QUESTION_ID]);
    const eId = eRoom.json.roomId as string;
    const eCandidate = await signUp("eval-candidate");
    await call("POST", "/rooms/join", eCandidate, { inviteCode: eRoom.json.inviteCode });
    const candidateId = userIdOf(eCandidate);
    const [eq1] = (await roomQuestionIds(eId, interviewer)) as [string];
    const run = await call("POST", "/submissions", eCandidate, { roomId: eId, roomQuestionId: eq1, language: "python", mode: "submit", code: SUM });
    await waitFor(run.json.submissionId, eCandidate);
    const note = await call("POST", `/rooms/${eId}/notes`, interviewer, { body: "Asked good clarifying questions" });
    const scoreBefore = (await call("GET", `/rooms/${eId}/review`, interviewer)).json.candidates[0].score;

    const path = `/rooms/${eId}/evaluations/${candidateId}`;
    const save = (token: string, body: unknown, who = candidateId) => call("PUT", `/rooms/${eId}/evaluations/${who}`, token, body);
    const submit = (token: string, revision: number) => call("POST", `${path}/submit`, token, { revision });
    const dims = (fill: (d: ReturnType<typeof emptyDimensions>[number], i: number) => object) => emptyDimensions().map((d, i) => ({ ...d, ...fill(d, i) }));

    // Drafting during the interview.
    const partial = { baseRevision: 0, recommendation: null, summary: "", dimensions: dims((_, i) => (i === 0 ? { rating: 3, evidence: [{ noteId: note.json.id }] } : {})) };
    const first = await save(interviewer, partial);
    check(
      "the interviewer saves a partial draft during the interview",
      first.status === 200 && first.json.status === "draft" && first.json.revision === 1 && first.json.dimensions[0].rating === 3 &&
        first.json.dimensions[0].evidence[0]?.noteId === note.json.id,
      `(${first.status} ${JSON.stringify(first.json).slice(0, 120)})`,
    );
    check("a stale tab (old revision) → 409 evaluation_changed", (await save(interviewer, partial)).json?.conflict === "evaluation_changed");
    check("submitting while the interview is open → 409 room_open", (await submit(interviewer, 1)).json?.conflict === "room_open");

    // Privacy and scope.
    for (const [who, token] of [["candidate", eCandidate], ["outsider", outsider]] as const) {
      const statuses = [(await save(token, { ...partial, baseRevision: 1 })).status, (await submit(token, 1)).status];
      check(`the ${who} can't save or submit an evaluation → 403`, statuses.every((st) => st === 403), `(${statuses.join(",")})`);
    }
    check("evaluating someone who isn't this room's candidate → 404", (await save(interviewer, { ...partial, baseRevision: 1 }, userIdOf(interviewer))).status === 404);
    const otherNote = await call("POST", `/rooms/${roomId}/notes`, interviewer, { body: "from another room" });
    check("evidence: another room's note → 404", (await save(interviewer, { ...partial, baseRevision: 1, dimensions: dims((_, i) => (i === 0 ? { evidence: [{ noteId: otherNote.json.id }] } : {})) })).status === 404);
    const othersRun = (await call("GET", `/rooms/${roomId}/submissions`, interviewer)).json[0]?.submissionId as string;
    check("evidence: a run from another room → 404", (await save(interviewer, { ...partial, baseRevision: 1, dimensions: dims((_, i) => (i === 0 ? { evidence: [{ submissionId: othersRun }] } : {})) })).status === 404);
    check("a score of 5 / a score plus Not observed → 400", (await save(interviewer, { ...partial, baseRevision: 1, dimensions: dims((_, i) => (i === 0 ? { rating: 5 } : {})) })).status === 400 &&
      (await save(interviewer, { ...partial, baseRevision: 1, dimensions: dims((_, i) => (i === 0 ? { rating: 2, notObserved: true } : {})) })).status === 400);
    const candidateSees = JSON.stringify([(await call("GET", `/rooms/${eId}`, eCandidate)).json, (await call("GET", "/rooms", eCandidate)).json]);
    check("the candidate's views never contain the evaluation", !candidateSees.includes("evaluation") && !candidateSees.includes("recommendation"));

    // After the interview: incomplete → 400 with problems; complete → submitted and locked.
    await call("POST", `/rooms/${eId}/close`, interviewer);
    const incomplete = await submit(interviewer, 1);
    check("submitting an incomplete evaluation → 400 with what's missing", incomplete.status === 400 && incomplete.json?.problems?.length === 4, `(${JSON.stringify(incomplete.json?.problems)})`);
    const complete = {
      baseRevision: 1,
      recommendation: "hire",
      summary: "Solid problem solver; tested well.",
      dimensions: dims((_, i) =>
        [
          { rating: 3, explanation: "Found the approach quickly", evidence: [{ noteId: note.json.id }] },
          { rating: 4, evidence: [{ submissionId: run.json.submissionId }] },
          { notObserved: true },
          { rating: 3 },
        ][i]!,
      ),
    };
    const saved = await save(interviewer, complete);
    check("drafts can still be saved after the interview ended", saved.status === 200 && saved.json.revision === 2);
    const submitted = await submit(interviewer, 2);
    check(
      "submit after the end: locked, with who and when",
      submitted.status === 200 && submitted.json.status === "submitted" && submitted.json.submittedBy?.id === userIdOf(interviewer) &&
        typeof submitted.json.submittedAt === "string" && submitted.json.recommendation === "hire",
      `(${submitted.status} ${JSON.stringify(submitted.json).slice(0, 140)})`,
    );
    check("…then saving → 409 evaluation_submitted; submitting again → 409", (await save(interviewer, { ...complete, baseRevision: 3 })).json?.conflict === "evaluation_submitted" &&
      (await submit(interviewer, 3)).json?.conflict === "evaluation_submitted");
    check("a note cited by the submitted evaluation can't be edited or deleted → 409 note_cited",
      (await call("PATCH", `/rooms/${eId}/notes/${note.json.id}`, interviewer, { body: "rewritten" })).json?.conflict === "note_cited" &&
        (await call("DELETE", `/rooms/${eId}/notes/${note.json.id}`, interviewer)).json?.conflict === "note_cited");
    const review = await call("GET", `/rooms/${eId}/review`, interviewer);
    const reviewed = review.json.candidates[0];
    check("the review carries the evaluation; the test score is unchanged by it",
      reviewed.evaluation?.status === "submitted" && reviewed.evaluation.dimensions[1].evidence[0]?.submissionId === run.json.submissionId && reviewed.score === scoreBefore,
      `(score ${scoreBefore} → ${reviewed.score})`);

    // The database enforces the lock and completeness itself.
    const { db: evDb, close: closeEvDb } = createDb(process.env.DATABASE_URL!, { max: 1 });
    const refused = async (op: () => Promise<unknown>) => {
      try {
        await op();
        return "";
      } catch (e) {
        return dbError(e as Error & { cause?: { message?: string } });
      }
    };
    const evId = submitted.json.id as string;
    const lockedUpdate = await refused(() => evDb.update(evaluations).set({ summary: "changed" }).where(eq(evaluations.id, evId)));
    const lockedScore = await refused(() => evDb.update(evaluationScores).set({ rating: 1 }).where(eq(evaluationScores.evaluationId, evId)));
    const lockedDelete = await refused(() => evDb.delete(evaluations).where(eq(evaluations.id, evId)));
    const lockedNote = await refused(() => evDb.delete(interviewNotes).where(eq(interviewNotes.id, note.json.id)));
    check("the database refuses changing a submitted evaluation, its scores, deleting it, or deleting a cited note",
      [lockedUpdate, lockedScore, lockedDelete, lockedNote].every((m) => m.includes("submitted and locked") || m.includes("cited by a submitted")),
      `(${[lockedUpdate, lockedScore, lockedDelete, lockedNote].map((m) => m.slice(0, 30)).join(" | ")})`);

    // …and refuses submitting an incomplete one, or one in an open room, even without the API.
    const r2 = await create(interviewer, [QUESTION_ID]);
    const c2 = await signUp("eval-db");
    await call("POST", "/rooms/join", c2, { inviteCode: r2.json.inviteCode });
    const draft2 = await call("PUT", `/rooms/${r2.json.roomId}/evaluations/${userIdOf(c2)}`, interviewer, { baseRevision: 0, recommendation: "hire", summary: "", dimensions: dims(() => ({ rating: 2 })) });
    const forceSubmit = () => evDb.update(evaluations).set({ status: "submitted", submittedAt: new Date(), submittedBy: userIdOf(interviewer) }).where(eq(evaluations.id, draft2.json.id));
    const whileOpen = await refused(forceSubmit);
    await call("POST", `/rooms/${r2.json.roomId}/close`, interviewer);
    await evDb.update(evaluationScores).set({ rating: null }).where(and(eq(evaluationScores.evaluationId, draft2.json.id), eq(evaluationScores.dimension, "code_quality")));
    const whenIncomplete = await refused(forceSubmit);
    check("the database refuses a submit while the room is open, and an incomplete submit",
      whileOpen.includes("after the interview ended") && whenIncomplete.includes("incomplete"), `(${whileOpen.slice(0, 50)} | ${whenIncomplete.slice(0, 50)})`);

    // Deleting the candidate's account still works: the locked evaluation goes with it (cascade).
    const accountDelete = await refused(() => evDb.execute(sql`delete from auth.users where id = ${candidateId}`));
    const [left] = await evDb.select({ id: evaluations.id }).from(evaluations).where(eq(evaluations.id, evId));
    await closeEvDb();
    check("deleting the candidate's account removes their submitted evaluation (cascade isn't blocked)", accountDelete === "" && left === undefined, `(${accountDelete.slice(0, 80)})`);
  }

  // --- After the session ends --------------------------------------------------------------------
  await call("POST", `/rooms/${roomId}/close`, interviewer);
  check("revealing in an ended room → 400", (await reveal(interviewer, roomId, rq3)).status === 400);
  const summary = await call("GET", "/rooms", candidate);
  check(
    "room list is titled by Q1 for the candidate",
    summary.json.find((r: any) => r.roomId === roomId)?.questionTitle === "Sum two numbers",
  );
}

main()
  .then(finish)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
