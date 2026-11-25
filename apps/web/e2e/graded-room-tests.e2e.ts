import { expect, test } from "@playwright/test";
import { replaceCode, results, startInterview, editorTab, selectedSubmission, submissionHistory } from "./helpers";

test("reviewed room tests update candidate grading without exposing hidden inputs or changing prior results", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  const roomUrl = iv.url();
  const candidateTests = cd.getByRole("region", { name: "Tests" });
  const interviewerTests = iv.getByRole("group", { name: "Graded room tests" });
  const notice = cd.getByText("The interviewer added additional tests. Please resubmit.");
  const hiddenInput = "314159 -271828";
  try {
    await expect(candidateTests.getByRole("button", { name: "Add a custom test case" })).toBeVisible();
    await expect(cd.getByRole("button", { name: "Suggest test cases" })).toHaveCount(0);
    await replaceCode(cd, "a, b = map(int, input().split())\nprint(a+b)");
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(selectedSubmission(cd)).toContainText("2/2 hidden tests passed");
    await expect(selectedSubmission(cd)).toContainText("Revision 0");
    await editorTab(cd, "Code").click();

    await iv.getByRole("tab", { name: "Testcase" }).click();
    await interviewerTests.getByRole("button", { name: "Add test case", exact: true }).click();
    await interviewerTests.getByLabel("Room test input").fill(hiddenInput);
    await interviewerTests.getByLabel("Room test expected output").fill("42331");
    const hidden = interviewerTests.getByRole("button", { name: "Add as hidden" });
    await expect(hidden).toBeDisabled();
    await interviewerTests.getByRole("checkbox", { name: "I confirm the expected output is correct." }).check();
    await hidden.click();
    await expect(notice).toBeVisible();
    await expect(cd.getByText(hiddenInput, { exact: true })).toHaveCount(0);

    await iv.route("**/tests/suggest", (route) => route.fulfill({ json: {
      tests: [
        { input: "-101 101", expectedOutput: "1", reason: "Opposite signs catch incorrect cancellation." },
        { input: "0 0", expectedOutput: "0", reason: "Two zeros catch treating zero as missing." },
        { input: "-10 -20", expectedOutput: "-30", reason: "Negative values catch clamping to zero." },
      ],
    } }));
    await interviewerTests.getByRole("button", { name: "Suggest test cases" }).click();
    const suggestions = interviewerTests.getByRole("list", { name: "Suggested room tests" });
    await expect(suggestions.getByRole("listitem")).toHaveCount(3);
    await expect(suggestions.getByText("Opposite signs catch incorrect cancellation.")).toBeVisible();
    await suggestions.getByRole("button", { name: "Review suggestion 1" }).click();
    await interviewerTests.getByLabel("Room test expected output").fill("0");
    await interviewerTests.getByRole("checkbox", { name: "I confirm the expected output is correct." }).check();
    await interviewerTests.getByRole("button", { name: "Add as public" }).click();
    await expect(suggestions.getByRole("listitem")).toHaveCount(2);
    await suggestions.getByRole("button", { name: "Review suggestion 1" }).click();
    await interviewerTests.getByRole("button", { name: "Discard remaining suggestions" }).click();
    await expect(suggestions).toHaveCount(0);
    await expect(interviewerTests.getByLabel("Room test input")).toHaveCount(0);
    await expect(interviewerTests.getByText("Room additions (2)")).toBeVisible();

    await iv.goto(`${roomUrl}/review`);
    await expect(iv.getByText("Needs resubmit", { exact: true })).toBeVisible();
    await expect(iv.getByLabel("Test score")).toHaveText("0 / 100");
    await iv.goto(roomUrl);

    await candidateTests.getByRole("tab", { name: "Testcase" }).click();
    await candidateTests.getByRole("button", { name: "Case 3", exact: true }).click();
    await expect(candidateTests.getByLabel("Case input")).toHaveText("-101 101");
    await expect(candidateTests.getByLabel("Case expected output")).toHaveText("0");
    await cd.getByRole("button", { name: "Run", exact: true }).click();
    await expect(results(cd)).toHaveCount(1);
    await expect(results(cd).first()).toContainText("Example 3");
    await expect(results(cd)).toContainText("Revision 2");
    await expect(notice).toBeVisible();
    await replaceCode(cd, "a, b = map(int, input().split())\nprint(0 if a == 314159 else a + b)");
    const posted = cd.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/submissions");
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    const authorization = await (await posted).request().headerValue("authorization");
    const candidateSubmit = selectedSubmission(cd);
    await expect(candidateSubmit).toContainText("2/3 hidden tests passed");
    await expect(candidateSubmit).toContainText("Revision 2");
    await expect(candidateSubmit.getByRole("table", { name: "Hidden test results" })).toHaveCount(0);
    await expect(candidateSubmit).not.toContainText(/Passed case|Hidden case/i);
    await expect(results(cd).first().locator("table.tests").getByRole("row")).toHaveCount(3);
    await expect(results(cd).first()).not.toContainText(/hidden|Wrong answer/i);
    await cd.getByRole("button", { name: "Back to submissions" }).click();
    await expect(submissionHistory(cd)).toHaveCount(2);
    await submissionHistory(cd).last().click();
    await expect(candidateSubmit).toContainText("Revision 0");
    await expect(candidateSubmit).toContainText("2/2 hidden tests passed");
    await expect(candidateSubmit.getByRole("table", { name: "Public test results" }).getByRole("row")).toHaveCount(2);

    await editorTab(iv, "Submissions").click();
    await submissionHistory(iv).first().click();
    const interviewerRows = selectedSubmission(iv).getByRole("table", { name: "Hidden test results" }).getByRole("row");
    await expect(interviewerRows).toHaveCount(3);
    await expect(interviewerRows.filter({ hasText: "Wrong answer" })).toHaveCount(1);
    await expect(interviewerRows.filter({ hasText: "Accepted" })).toHaveCount(2);
    const inspected = iv.waitForResponse((r) => new URL(r.url()).pathname.includes("/hidden-tests/"));
    await interviewerRows.filter({ hasText: "Wrong answer" }).getByRole("button", { name: "Inspect hidden case 3" }).click();
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveText(hiddenInput);
    await expect(selectedSubmission(iv).getByLabel("Hidden case expected output")).toHaveText("42331");
    const denied = await cd.request.get((await inspected).url(), { headers: { authorization: authorization! } });
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toContain(hiddenInput);

    await editorTab(cd, "Code").click();
    await expect(notice).toHaveCount(0);
    await iv.goto(`${roomUrl}/review`);
    await expect(iv.getByLabel("Test score")).toHaveText("83.3 / 100");
    await expect(iv.getByText("Needs resubmit", { exact: true })).toHaveCount(0);
  } finally {
    await close();
  }
});
