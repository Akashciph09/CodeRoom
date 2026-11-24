import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { CandidateQuestionView, QuestionDetail } from "@coderoom/shared";
import { createApp } from "../src/app.js";
import { call, check, finish, signUp } from "./lib.js";

const brief = "Entry-level arithmetic, ten minutes";
const statement = "Read one integer and print twice its value.";
const referencePython = "print(2 * int(input()))";
let calls = 0;
const server = createApp(undefined, async (input) => {
  calls++;
  if (input !== brief) throw new Error("Unexpected brief");
  return {
    title: "Double the input",
    statement,
    constraints: "The integer is between -100 and 100.",
    starterCode: { python: "# Read an integer and print the answer", javascript: "// Read an integer and print the answer" },
    referencePython,
    tests: [
      { input: "3\n", expectedOutput: "6", isHidden: false },
      { input: "-2\n", expectedOutput: "4", isHidden: true },
    ],
  };
}).listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const [owner, other] = await Promise.all([signUp("generate-owner"), signUp("generate-other")]);
  const generate = (token?: string, body: unknown = { brief }) => call("POST", "/questions/generate", token, body, base);
  const denied = await generate();
  const invalid = await generate(owner, { brief: " " });
  check("generation authenticates and validates the brief before calling a model", denied.status === 401 && invalid.status === 400 && calls === 0);
  const created = await generate(owner);
  if (created.status !== 201) throw new Error(`Generation failed with ${created.status}`);
  const question = QuestionDetail.parse(created.json);
  const draft = question.draft;
  if (!draft) throw new Error("Generated draft missing");
  check("real worker flags a bad expectation and returns a passing reference check",
    draft.tests[0]?.referenceVerdict === "accepted" && draft.tests[1]?.referenceVerdict === "wrong_answer");
  check("generation returns a draft and excludes the reference program",
    question.latest === null && !JSON.stringify(created.json).includes(referencePython));
  const path = `/questions/${question.id}`;
  const [outsider, earlyRoom, preview] = await Promise.all([
    call("GET", path, other, undefined, base),
    call("POST", "/rooms", owner, { questionIds: [question.id], name: "Generated question" }, base),
    call("GET", `${path}/preview`, owner, undefined, base),
  ]);
  const visible = CandidateQuestionView.parse(preview.json);
  check("the owner can preview public tests only, and the draft is unavailable for interviews",
    outsider.status === 404 && earlyRoom.status === 400 && visible.publicTests.length === 1
    && JSON.stringify(visible.publicTests).includes("3\\n") && !JSON.stringify(preview.json).includes("referenceVerdict"));
  const saved = await call("PUT", `${path}/draft`, owner, {
    baseRevision: question.revision,
    title: draft.title,
    statement,
    constraints: draft.constraints,
    starterCode: draft.starterCode,
    tests: [
      { input: "3\n", expectedOutput: "6", isHidden: false },
      { input: "-2\n", expectedOutput: "-4", isHidden: true },
    ],
  }, base);
  const edited = QuestionDetail.parse(saved.json);
  check("changing expected output clears its verdict and preserves unchanged checks",
    edited.draft?.tests[0]?.referenceVerdict === "accepted" && !edited.draft?.tests[1]?.referenceVerdict);
  const ready = await call("POST", `${path}/publish`, owner, { revision: edited.revision }, base);
  check("only explicit approval publishes the question", ready.status === 200 && ready.json.latest?.status === "published");
  const published = QuestionDetail.parse(ready.json);
  if (!published.latest) throw new Error("Published version missing");
  const { title, constraints, starterCode, tests } = published.latest;
  const titleEdit = await call("PUT", `${path}/draft`, owner, {
    baseRevision: published.revision,
    title: `${title} (revised)`,
    statement,
    constraints,
    starterCode,
    tests: tests.map(({ input, expectedOutput, isHidden }) => ({ input, expectedOutput, isHidden })),
  }, base);
  const newDraft = QuestionDetail.parse(titleEdit.json).draft;
  check("a title-only edit of a ready question keeps its unchanged reference check",
    titleEdit.status === 200 && newDraft?.tests[0]?.referenceVerdict === "accepted"
    && !newDraft?.tests[1]?.referenceVerdict);
} finally {
  server.close();
}

finish();
