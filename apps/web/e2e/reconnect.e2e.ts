import { expect, test } from "@playwright/test";
import { appendLine, editorText, liveStatus, replaceCode, startInterview, editorTab, selectedSubmission, submissionHistory } from "./helpers";

// Sleeps so the run reliably finishes while the candidate is disconnected, then prints the right answer.
const SLOW_SOLUTION = "import time\ntime.sleep(1.2)\na, b = map(int, input().split())\nprint(a + b)";
const CANDIDATE_OFFLINE_EDIT = "# candidate: typed while offline";
const INTERVIEWER_EDIT = "# interviewer: typed while the candidate was offline";

/**
 * The candidate's realtime connections drop mid-interview. While they're gone, their submission
 * finishes and both people keep typing. When the connection comes back — with no page reload —
 * the candidate must see the result they missed, and both editors must converge to the same code
 * containing both people's edits.
 */
test("candidate recovers code and results after a dropped connection", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  try {
    await test.step("candidate writes a solution that both see", async () => {
      await replaceCode(candidate.page, SLOW_SOLUTION);
      await expect.poll(() => editorText(interviewer.page)).toBe(SLOW_SOLUTION);
    });

    await test.step("candidate submits, then loses their connection", async () => {
      await candidate.page.getByRole("button", { name: "Submit" }).click();
      await expect(selectedSubmission(candidate.page)).toContainText(/Queued|Running/);
      await candidate.realtime.drop();
      await expect(liveStatus(candidate.page)).toHaveText("reconnecting…");
    });

    await test.step("while they're offline, the run finishes and both keep typing", async () => {
      // The interviewer (still connected) gets the result live…
      await editorTab(interviewer.page, "Submissions").click();
      await submissionHistory(interviewer.page).first().click();
      await expect(selectedSubmission(interviewer.page)).toContainText("Accepted", { timeout: 30_000 });
      // …the candidate can't: their card is stuck on the state from before the drop.
      await expect(selectedSubmission(candidate.page)).toContainText(/Queued|Running/);

      await editorTab(interviewer.page, "Code").click();
      await editorTab(candidate.page, "Code").click();
      await appendLine(interviewer.page, INTERVIEWER_EDIT);
      await appendLine(candidate.page, CANDIDATE_OFFLINE_EDIT); // local-only until reconnect
      expect(await editorText(candidate.page)).not.toContain(INTERVIEWER_EDIT);
      expect(await editorText(interviewer.page)).not.toContain(CANDIDATE_OFFLINE_EDIT);
    });

    await test.step("connection returns: results and code recover without a reload", async () => {
      await candidate.realtime.restore();
      await expect(liveStatus(candidate.page)).toHaveText("live", { timeout: 30_000 });

      // Missed result recovered from history on reconnect.
      await editorTab(candidate.page, "Submissions").click();
      await expect(submissionHistory(candidate.page)).toHaveCount(1);
      await submissionHistory(candidate.page).first().click();
      await expect(selectedSubmission(candidate.page)).toContainText("2/2 hidden tests passed");
      await editorTab(candidate.page, "Code").click();

      // Both edits made during the gap reach both sides, and the documents converge.
      for (const p of [candidate, interviewer]) {
        await expect.poll(() => editorText(p.page)).toContain(INTERVIEWER_EDIT);
        await expect.poll(() => editorText(p.page)).toContain(CANDIDATE_OFFLINE_EDIT);
      }
      await expect.poll(async () => (await editorText(candidate.page)) === (await editorText(interviewer.page))).toBe(true);
    });
  } finally {
    await close();
  }
});
