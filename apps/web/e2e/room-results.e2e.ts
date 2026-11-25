import { expect, test } from "@playwright/test";
import { editorTab, editorText, expectUnchanged, replaceCode, results, selectedSubmission, startInterview, submissionHistory, testResultTab } from "./helpers";

test("only the newest Run is shown, even if the first result arrives late", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await testResultTab(iv).click();
    await expect(iv.getByText("Run your code to see test results.")).toBeVisible();
    const olderQueued = interviewer.realtime.holdNextEvent("submission:queued");
    const olderResult = interviewer.realtime.holdNextEvent("submission:result");

    await replaceCode(cd, "print(-111)");
    await cd.getByRole("button", { name: "Run", exact: true }).click();
    await expect(results(cd).locator(".output pre").first()).toHaveText("-111");
    await Promise.all([olderQueued.received, olderResult.received]);

    await replaceCode(cd, "print(-222)");
    await cd.getByRole("button", { name: "Run", exact: true }).click();
    for (const page of [cd, iv]) {
      await expect(results(page)).toHaveCount(1);
      await expect(results(page).locator(".output pre").first()).toHaveText("-222");
    }
    olderResult.release();
    olderQueued.release();
    await expectUnchanged(() => results(iv).locator(".output pre").first().innerText(), "-222");
    await expect(results(cd)).toHaveCount(1);
    await editorTab(cd, "Submissions").click();
    await expect(cd.getByText("No submissions for this question yet.")).toBeVisible();
  } finally {
    await close();
  }
});

test("history opens one snapshot and incoming Submits leave the interviewer on the selected attempt", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    const original = "print(-111)  # original snapshot";
    await replaceCode(cd, original);
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(selectedSubmission(cd)).toContainText("Wrong answer");
    await expect(testResultTab(cd)).not.toHaveAttribute("aria-selected", "true");
    await testResultTab(cd).click();
    await expect(cd.getByText("Run your code to see test results.")).toBeVisible();

    await expect(editorTab(iv, "Code")).toHaveAttribute("aria-selected", "true");
    await editorTab(iv, "Submissions").click();
    await expect(submissionHistory(iv)).toHaveCount(1);
    await submissionHistory(iv).first().click();
    await selectedSubmission(iv).getByRole("button", { name: "Inspect hidden case 1", exact: true }).click();
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveText("-5 5");
    await expect(selectedSubmission(iv).getByLabel("Hidden case expected output")).toHaveText("0");
    await selectedSubmission(iv).getByRole("button", { name: "Inspect hidden case 2", exact: true }).click();
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveCount(2);
    await selectedSubmission(iv).getByRole("button", { name: "Replay case", exact: true }).first().click();
    await expect(selectedSubmission(iv).getByLabel("Candidate output from replay")).toHaveText("-111");
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveCount(2);
    await selectedSubmission(iv).getByRole("button", { name: "Hide hidden case 1", exact: true }).click();
    await expect(selectedSubmission(iv).getByRole("button", { name: "Hide hidden case 2", exact: true })).toBeVisible();
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveCount(1);
    await selectedSubmission(iv).getByRole("button", { name: "Hide hidden case 2", exact: true }).click();
    await expect(selectedSubmission(iv).getByLabel("Hidden case input")).toHaveCount(0);
    await selectedSubmission(iv).getByText("Submitted code", { exact: true }).click();
    await expect(selectedSubmission(iv).locator(".code-snapshot")).toHaveText(original);

    await editorTab(cd, "Code").click();
    const newer = "a, b = map(int, input().split())\nprint(a + b)  # newer snapshot";
    await replaceCode(cd, newer);
    const posted = cd.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/submissions");
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    const response = await posted;
    await expect(selectedSubmission(cd)).toContainText("2/2 hidden tests passed");
    await expect(selectedSubmission(iv)).toHaveCount(1);
    await expectUnchanged(() => selectedSubmission(iv).locator(".code-snapshot").innerText(), original);

    const authorization = await response.request().headerValue("authorization");
    const { submissionId } = await response.json();
    const details = await cd.request.get(new URL(`/submissions/${submissionId}`, response.url()).href, { headers: { authorization: authorization! } });
    expect(details.ok()).toBeTruthy();
    const candidateView = await details.json();
    expect(candidateView).toMatchObject({ language: "python", hiddenPassed: 2, hiddenTotal: 2 });
    expect(candidateView).not.toHaveProperty("results");
    expect(candidateView).not.toHaveProperty("code");
    expect(candidateView.publicResults).toHaveLength(2);
    for (const result of candidateView.publicResults) expect(result).not.toHaveProperty("hidden");
    await expect(selectedSubmission(cd).getByRole("table", { name: "Hidden test results" })).toHaveCount(0);
    await expect(selectedSubmission(cd).getByText("Submitted code")).toHaveCount(0);

    await iv.getByRole("button", { name: "Back to submissions" }).click();
    await expect(selectedSubmission(iv)).toHaveCount(0);
    await expect(submissionHistory(iv)).toHaveCount(2);
    await expect(submissionHistory(iv).first()).toHaveAccessibleName(/^Submission 2 /);
    await expect(submissionHistory(iv).last()).toHaveAccessibleName(/^Submission 1 /);
    await expect(submissionHistory(iv).first()).toContainText("Accepted");
    await expect(submissionHistory(iv).last()).toContainText("Wrong answer");
    await expect(submissionHistory(iv).first()).toContainText("Python");
    await expect(submissionHistory(iv).first().locator("time")).toHaveAttribute("datetime", /T/);
    await submissionHistory(iv).last().click();
    await expect(selectedSubmission(iv)).toHaveCount(1);
    await expect(selectedSubmission(iv)).toContainText("Wrong answer");
    await editorTab(iv, "Code").click();
    await expect.poll(() => editorText(iv)).toBe(newer);
  } finally {
    await close();
  }
});
