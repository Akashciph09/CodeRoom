import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { submissions } from "@coderoom/db";
import { createApp } from "../src/app.js";
import { db } from "../src/db.js";
import { enqueueExecution } from "../src/queue.js";
import { call, check, finish, QUESTION_ID, signUp, sleep, userIdOf } from "./lib.js";

const code = "a, b = map(int, input().split())\nprint(a + b)";
const hiddenInput = "876543 -234567";
let modelEvidence = "";
const server = createApp(undefined, undefined, async (evidence) => {
  modelEvidence = evidence;
  return { tests: [
    { input: "-21 21", expectedOutput: "0", reason: "Opposite signs catch taking absolute values." },
    { input: "0 0", expectedOutput: "0", reason: "Two zeros catch treating zero as missing." },
    { input: "-8 -6", expectedOutput: "-14", reason: "Two negatives catch clamping the result to zero." },
  ] };
}).listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const [interviewer, candidate, outsider] = await Promise.all([
    signUp("room-test-interviewer"), signUp("room-test-candidate"), signUp("room-test-outsider"),
  ]);
  const create = () => call("POST", "/rooms", interviewer, { questionIds: [QUESTION_ID] }, base);
  const { json: room } = await create();
  const { json: otherRoom } = await create();
  const roomPath = `/rooms/${room.roomId}`;
  await call("POST", "/rooms/join", candidate, { inviteCode: room.inviteCode }, base);
  const original = (await call("GET", roomPath, candidate, undefined, base)).json.questions[0];
  const initialPublic = original.question.publicTests.length;
  const initialHidden = original.question.hiddenTestCount;
  const path = `${roomPath}/questions/${original.id}/tests`;
  const add = (body: unknown, token = interviewer) => call("POST", path, token, body, base);

  async function waitForSubmission(id: string) {
    const resultPath = `/submissions/${id}`;
    for (let i = 0; i < 80; i++) {
      const result = (await call("GET", resultPath, candidate, undefined, base)).json;
      if (result.status === "completed" || result.status === "failed") return { result, resultPath };
      await sleep(250);
    }
    throw new Error("Submission did not finish");
  }

  async function run(mode: "run" | "submit", source = code) {
    const queued = await call("POST", "/submissions", candidate, {
      roomId: room.roomId, roomQuestionId: original.id, language: "python", mode, code: source,
    }, base);
    if (queued.status !== 202) throw new Error(`Queue request failed: ${queued.status}`);
    return waitForSubmission(queued.json.submissionId);
  }

  const old = await run("submit");
  // Model an enqueue delay: the submission snapshot exists before the additions, but reaches the worker after.
  const [delayed] = await db.insert(submissions).values({
    roomId: room.roomId, roomQuestionId: original.id, questionVersionId: original.question.versionId,
    userId: userIdOf(candidate), language: "python", mode: "submit", roomTestRevision: original.testRevision, code,
  }).returning({ id: submissions.id });
  const hidden = { input: hiddenInput, expectedOutput: "641976", isHidden: true };
  const denied = await Promise.all([add({ ...hidden, confirmed: true }, candidate), add({ ...hidden, confirmed: true }, outsider),
    call("POST", `${path}/suggest`, candidate, undefined, base)]);
  check("only the interviewer can add or suggest room tests", denied.every((reply) => reply.status === 403));

  check("unverified output requires explicit confirmation", (await add(hidden)).status === 400);
  const mismatch = await add({ ...hidden, expectedOutput: "42", referencePython: code });
  check("worker rejects an incorrect expected output before adding it", mismatch.status === 400 && mismatch.json.error.includes("wrong_answer"));
  check("reference check allows adding the exact hidden case", (await add({ ...hidden, referencePython: code })).status === 204);
  const suggestion = await call("POST", `${path}/suggest`, interviewer, undefined, base);
  check("AI proposes exactly three explained cases without seeing existing hidden inputs",
    suggestion.status === 200 && suggestion.json.tests.length === 3
    && suggestion.json.tests.every((test: { reason: string }) => Boolean(test.reason)) && !modelEvidence.includes(hiddenInput));

  const publicCase = { input: "-21 21", expectedOutput: "0", isHidden: false, confirmed: true };
  check("an explicitly confirmed public case can be added", (await add(publicCase)).status === 204);
  await enqueueExecution({ submissionId: delayed!.id });
  const queuedBeforeAdditions = (await waitForSubmission(delayed!.id)).result;
  check("a job processed after additions still grades against its earlier snapshot",
    queuedBeforeAdditions.status === "completed" && queuedBeforeAdditions.roomTestRevision === 0
    && queuedBeforeAdditions.publicResults.length === initialPublic && queuedBeforeAdditions.hiddenTotal === initialHidden);
  const candidateRoom = await call("GET", roomPath, candidate, undefined, base);
  const candidateQuestion = candidateRoom.json.questions[0];
  const ownerRoom = await call("GET", roomPath, interviewer, undefined, base);
  const other = await call("GET", `/rooms/${otherRoom.roomId}`, interviewer, undefined, base);
  check("public cases are visible, hidden inputs stay private, and other rooms remain intact",
    candidateQuestion.question.publicTests.some((test: { input: string }) => test.input === publicCase.input)
    && !("addedTests" in candidateQuestion) && !JSON.stringify(candidateRoom.json).includes(hiddenInput)
    && ownerRoom.json.questions[0].addedTests.length === 2 && other.json.questions[0].testRevision === 0);

  const laterRun = (await run("run")).result;
  const laterSubmit = (await run("submit")).result;
  const previous = (await call("GET", old.resultPath, candidate, undefined, base)).json;
  check("Run grades public additions and Submit also grades hidden additions",
    laterRun.overall === "accepted" && laterRun.publicResults.length === initialPublic + 1
    && laterRun.hiddenTotal === undefined && laterSubmit.overall === "accepted"
    && laterSubmit.publicResults.length === initialPublic + 1 && laterSubmit.hiddenTotal === initialHidden + 1
    && laterSubmit.roomTestRevision === 2 && !JSON.stringify(laterSubmit).includes(hiddenInput));
  check("old submissions retain their results and revision",
    JSON.stringify(previous) === JSON.stringify(old.result) && previous.roomTestRevision === 0);
  const failed = await run("submit", "print(-12345)");
  const hiddenId = ownerRoom.json.questions[0].addedTests.find((test: { isHidden: boolean }) => test.isHidden).id;
  const inspection = `${failed.resultPath}/hidden-tests/${hiddenId}`;
  const inspect = (url: string, token = interviewer) => call("GET", url, token, undefined, base);
  const [inspected, deniedCandidate, deniedOutsider, beforeAddition, passed] = await Promise.all([
    inspect(inspection), inspect(inspection, candidate), inspect(inspection, outsider),
    inspect(`${old.resultPath}/hidden-tests/${hiddenId}`),
    inspect(`/submissions/${laterSubmit.submissionId}/hidden-tests/${hiddenId}`),
  ]);
  check("only the room interviewer can inspect a failed hidden case from the pinned suite",
    inspected.status === 200 && inspected.json.input === hiddenInput && inspected.json.expectedOutput === hidden.expectedOutput
    && !Object.hasOwn(inspected.json, "stdout") && !Object.hasOwn(inspected.json, "stderr")
    && deniedCandidate.status === 403 && deniedOutsider.status === 403 && beforeAddition.status === 404 && passed.status === 404);
  const replay = await call("POST", `${inspection}/replay`, interviewer, undefined, base);
  const replayDenied = await call("POST", `${inspection}/replay`, candidate, undefined, base);
  const afterReplay = await call("GET", failed.resultPath, candidate, undefined, base);
  check("replay runs the pinned case privately without changing the original result",
    replay.status === 200 && replay.json.stdout.trim() === "-12345" && replay.json.verdict === "wrong_answer"
    && replayDenied.status === 403 && JSON.stringify(afterReplay.json) === JSON.stringify(failed.result));
  const review = await call("GET", `${roomPath}/review`, interviewer, undefined, base);
  check("review counts added tests on the new submission", review.json.candidates[0].submissions.some(
    (entry: { submissionId: string; total: number }) => entry.submissionId === laterSubmit.submissionId
      && entry.total === initialPublic + initialHidden + 2,
  ));
  await call("POST", `${roomPath}/close`, interviewer, undefined, base);
  check("ended rooms refuse additional tests", (await add({ ...publicCase, input: "101 100" })).status === 400);
} finally {
  server.close();
}

finish();
