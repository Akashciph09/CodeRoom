/**
 * Multi-question rooms (ADR 0009) against the running stack (supabase, redis, api, worker).
 *   pnpm smoke   (runs smoke.ts, questions-smoke.ts, then this) — or: pnpm smoke:rooms
 *
 * Guarantees checked here:
 *  - the candidate never receives an unrevealed question (content or count) and can't submit to one;
 *  - questions are revealed only by the interviewer, strictly in order, idempotently — also under races;
 *  - every submission is graded against its own question's pinned version, enforced by the database.
 */
import { randomUUID } from "node:crypto";
import { createDb, eq, roomQuestions, submissions } from "@coderoom/db";
import { call, check, finish, QUESTION_ID, roomQuestionIds, signUp, sleep, userIdOf } from "./lib.js";

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

/** Create and publish a question owned by `token` (one public + one hidden test). */
async function readyQuestion(token: string, title: string, statement: string, tests: [string, string][]) {
  const created = await call("POST", "/questions", token, { title });
  const qid = created.json.id as string;
  const saved = await call("PUT", `/questions/${qid}/draft`, token, {
    baseRevision: created.json.revision,
    title,
    statement,
    constraints: "",
    starterCode: {},
    tests: tests.map(([input, expectedOutput], i) => ({ input, expectedOutput, isHidden: i > 0 })),
  });
  const published = await call("POST", `/questions/${qid}/publish`, token, { revision: saved.json.revision });
  if (published.status !== 200) throw new Error(`publish ${title} → ${published.status} ${JSON.stringify(published.json)}`);
  return qid;
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
