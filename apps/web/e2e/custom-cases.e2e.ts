import { expect, test, type Page } from "@playwright/test";
import { expectUnchanged, replaceCode, results, startInterview } from "./helpers";

/*
 * Shared custom test cases and the interview timer (ADR 0010).
 */

const SUM = "a, b = map(int, input().split())\nprint(a + b)";
const testsPane = (page: Page) => page.getByRole("region", { name: "Tests" });
const caseButton = (page: Page, name: string) => testsPane(page).getByRole("button", { name, exact: true });

async function addCase(page: Page, input: string, expected?: string) {
  await page.bringToFront();
  await testsPane(page).getByRole("tab", { name: "Testcase" }).click();
  await testsPane(page).getByRole("button", { name: "Add a custom test case" }).click();
  await page.getByLabel("New case input").fill(input);
  if (expected !== undefined) await page.getByLabel("New case expected output").fill(expected);
  await page.getByRole("button", { name: "Add case" }).click();
}

test("both participants add test cases, see each other's, and the candidate runs them", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await test.step("the interviewer proposes an edge case; the candidate sees it", async () => {
      await addCase(iv, "-5 5", "0");
      await expect(caseButton(iv, "Custom 1")).toHaveAttribute("aria-pressed", "true"); // selected after adding

      await expect(caseButton(cd, "Custom 1")).toBeVisible();
      await caseButton(cd, "Custom 1").click();
      await expect(testsPane(cd).getByLabel("Case input")).toHaveText("-5 5");
      await expect(testsPane(cd).getByLabel("Case expected output")).toHaveText("0");
      await expect(testsPane(cd)).toContainText("Added by Iris Interviewer (interviewer)");
    });

    await test.step("the candidate adds one without an expected output; the interviewer sees it", async () => {
      await addCase(cd, "7 8");
      await expect(caseButton(iv, "Custom 2")).toBeVisible();
      await caseButton(iv, "Custom 2").click();
      await expect(testsPane(iv).getByLabel("Case input")).toHaveText("7 8");
      await expect(testsPane(iv).getByLabel("Case expected output")).toContainText("not set");
      await expect(testsPane(iv)).toContainText("Added by Casey Candidate (candidate)");
    });

    await test.step("Run includes the custom cases; both see their results, ungraded", async () => {
      await replaceCode(cd, SUM);
      await cd.getByRole("button", { name: "Run", exact: true }).click();
      const card = results(cd).first();
      await expect(card).toContainText("Accepted"); // the question's examples
      await expect(card).toContainText("Custom cases · not graded · 1/1 matched");
      await expect(card.getByLabel("Custom 1 output")).toHaveText("0");
      await expect(card.getByLabel("Custom 2 output")).toHaveText("15");
      await expect(card.locator("table.custom-results")).toContainText("Ran"); // no expected output → just ran

      const ivCard = results(iv).first();
      await expect(ivCard.getByLabel("Custom 2 output")).toHaveText("15");
    });

    await test.step("removing a case removes it for both; Submit never runs custom cases", async () => {
      await cd.bringToFront();
      await testsPane(cd).getByRole("tab", { name: "Testcase" }).click();
      await caseButton(cd, "Custom 2").click();
      await testsPane(cd).getByRole("button", { name: "Remove" }).click();
      await expect(caseButton(cd, "Custom 2")).toHaveCount(0);
      // The interviewer's panel switched to Test Result on the run; look at their case list.
      await testsPane(iv).getByRole("tab", { name: "Testcase" }).click();
      await expect(caseButton(iv, "Custom 1")).toBeVisible(); // proves the list is on screen…
      await expect(caseButton(iv, "Custom 2")).toHaveCount(0); // …so this absence means removed

      await cd.getByRole("button", { name: "Submit" }).click();
      await expect(results(cd)).toHaveCount(2);
      await expect(results(cd).first()).toContainText("hidden tests 2/2");
      await expect(results(cd).first().locator("table.custom-results")).toHaveCount(0);
    });

    await test.step("cases survive a reload", async () => {
      await cd.reload();
      await testsPane(cd).getByRole("tab", { name: "Testcase" }).click();
      await expect(caseButton(cd, "Custom 1")).toBeVisible();
      await expect(caseButton(cd, "Custom 2")).toHaveCount(0);
    });
  } finally {
    await close();
  }
});

test("the interviewer sees how long the interview has run; it stops when the session ends", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  try {
    const timer = iv.getByRole("timer", { name: "Interview time" });
    await expect(timer).toHaveText(/⏱ \d+:\d{2}/);
    await expect(candidate.page.getByRole("timer")).toHaveCount(0); // interviewer only

    const first = await timer.textContent();
    await expect.poll(() => timer.textContent(), { timeout: 5000 }).not.toBe(first); // ticking

    iv.once("dialog", (d) => d.accept());
    await iv.getByRole("button", { name: "End session" }).click();
    await expect(iv.getByText("This interview has ended.")).toBeVisible();
    const stopped = (await timer.textContent())!;
    await expectUnchanged(async () => (await timer.textContent())!, stopped, 2500);
    await expect(testsPane(iv).getByRole("button", { name: "Add a custom test case" })).toHaveCount(0); // read-only

    await iv.reload(); // stays stopped at the recorded end time
    await expect(timer).toHaveText(stopped);
  } finally {
    await close();
  }
});

/**
 * Regression (PR #6 review): concurrent additions can push the shared list past the 10-case limit
 * (the + check is per client). Run must keep working: it sends the first 10 in the shared list's
 * order (identical on every client) and the extras are clearly marked as not run.
 */
test("competing additions past the limit don't break Run", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    for (let i = 1; i <= 9; i++) await addCase(iv, `${i} ${i}`, String(2 * i));
    await expect(caseButton(cd, "Custom 9")).toBeVisible();

    // Both open "+" at 9 cases; the candidate is briefly disconnected, so neither sees the other's add.
    await testsPane(cd).getByRole("button", { name: "Add a custom test case" }).click();
    await testsPane(iv).getByRole("button", { name: "Add a custom test case" }).click();
    await candidate.realtime.drop();
    await iv.getByLabel("New case input").fill("100 100");
    await iv.getByRole("button", { name: "Add case" }).click();
    await cd.bringToFront();
    await cd.getByLabel("New case input").fill("200 200");
    await cd.getByRole("button", { name: "Add case" }).click();
    candidate.realtime.restore();

    // Both now hold 11 cases, in the same order, with the 11th marked as not run.
    const eleventh: string[] = [];
    for (const page of [iv, cd]) {
      await expect(caseButton(page, "Custom 11")).toBeVisible({ timeout: 20_000 });
      await expect(testsPane(page)).toContainText("Only the first 10 custom cases run");
      await caseButton(page, "Custom 11").click();
      eleventh.push((await testsPane(page).getByLabel("Case input").textContent())!);
    }
    expect(eleventh[0]).toBe(eleventh[1]); // same merged order on both sides

    await replaceCode(cd, SUM);
    await cd.getByRole("button", { name: "Run", exact: true }).click();
    const card = results(cd).first();
    await expect(card).toContainText("Accepted");
    await expect(card.locator("table.custom-results tr")).toHaveCount(10); // exactly the first 10 ran
    await expect(card).toContainText("9/9 matched"); // the 9 with expected outputs; the 10th just "Ran"
    await expect(card.getByLabel("Custom 11 output")).toHaveCount(0);

    // At the limit, adding is refused with an explanation rather than silently overflowing again.
    await testsPane(cd).getByRole("tab", { name: "Testcase" }).click();
    await expect(testsPane(cd).getByRole("button", { name: "Add a custom test case" })).toBeDisabled();
  } finally {
    await close();
  }
});

/** Regression (PR #6 review): a form left open when the session ends must not add a case. */
test("an add-case form open when the session ends can't add a case", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await cd.bringToFront();
    await testsPane(cd).getByRole("button", { name: "Add a custom test case" }).click();
    await cd.getByLabel("New case input").fill("1 2");

    await iv.bringToFront();
    iv.once("dialog", (d) => d.accept());
    await iv.getByRole("button", { name: "End session" }).click();

    await expect(cd.getByText("This interview has ended.")).toBeVisible();
    await expect(cd.getByRole("button", { name: "Add case" })).toHaveCount(0); // form closed
    await expect(cd.getByLabel("New case input")).toHaveCount(0);
    await expect(caseButton(cd, "Custom 1")).toHaveCount(0);
    await expect(caseButton(cd, "Case 1")).toBeVisible(); // the case list is on screen, so the absence counts
  } finally {
    await close();
  }
});
