import { expect, test, type Page } from "@playwright/test";
import { authorQuestion, editorText, expectUnchanged, openAs, replaceCode, results, signUp } from "./helpers";

/*
 * Multi-question rooms (ADR 0009): the interviewer picks an ordered list, reveals questions one at a
 * time; the candidate only ever sees revealed ones, each with its own code, graded on its own tests.
 */

const SUM = "a, b = map(int, input().split())\nprint(a + b)";
const PRODUCT = "a, b = map(int, input().split())\nprint(a * b)";
const DIFFERENCE = "a, b = map(int, input().split())\nprint(a - b)";

const questionPanel = (page: Page) => page.getByRole("complementary", { name: "Question" });
const nav = (page: Page) => page.getByRole("navigation", { name: "Questions" });
const navButton = (page: Page, n: number) => nav(page).getByRole("button", { name: new RegExp(`^Q${n}:`) });
const resultsHeading = (page: Page) => page.locator(".results-panel h2");
/** Test-case rows of the newest result card. */
const testRows = (page: Page) => results(page).first().locator("table.tests tr");

test("interviewer reveals questions one by one; the candidate sees only revealed ones", async ({ browser }) => {
  const interviewer = await openAs(browser, "Iris Interviewer");
  const candidate = await openAs(browser, "Casey Candidate");
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await test.step("interviewer builds an ordered 3-question interview", async () => {
      await iv.goto("/");
      await signUp(iv, interviewer.name);
      await authorQuestion(iv, "Multiply two numbers", "# multiply\n", "2 3", "6");
      await authorQuestion(iv, "Subtract two numbers", "# subtract\n", "5 3", "2");

      await iv.goto("/");
      const picked = iv.getByLabel("Interview questions").getByRole("listitem");
      const order = ["Sum two numbers", "Multiply two numbers", "Subtract two numbers"];
      const labels: Record<string, string> = {
        "Sum two numbers": "Sum two numbers · v1 (library)",
        "Multiply two numbers": "Multiply two numbers · v1 (yours)",
        "Subtract two numbers": "Subtract two numbers · v1 (yours)",
      };
      // The list starts with one question preselected; add the missing ones, then order them.
      await expect(picked).toHaveCount(1);
      for (const title of order) {
        if ((await picked.filter({ hasText: title }).count()) > 0) continue;
        await iv.getByLabel("Question to add").selectOption({ label: labels[title]! });
        await iv.getByRole("button", { name: "Add question" }).click();
      }
      for (const [target, title] of order.entries()) {
        let at = (await picked.allTextContents()).findIndex((t) => t.includes(title));
        while (at > target) {
          await iv.getByRole("button", { name: `Move Q${at + 1} up` }).click();
          at--;
        }
      }
      await expect(picked).toHaveText([/Q1.*Sum two numbers/, /Q2.*Multiply two numbers/, /Q3.*Subtract two numbers/]);

      // Reordering works (then put it back).
      await iv.getByRole("button", { name: "Move Q3 up" }).click();
      await expect(picked.nth(1)).toContainText("Subtract");
      await iv.getByRole("button", { name: "Move Q2 down" }).click();
      await expect(picked.nth(1)).toContainText("Multiply");

      await iv.getByRole("button", { name: "Create room" }).click();
      await expect(iv).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
      await expect(navButton(iv, 1)).toHaveAttribute("aria-current", "true");
      await expect(navButton(iv, 2)).toHaveAccessibleName("Q2: Multiply two numbers (not revealed)");
      await expect(navButton(iv, 3)).toHaveAccessibleName("Q3: Subtract two numbers (not revealed)");
    });

    await test.step("candidate joins and sees only Q1 — no hint that more questions exist", async () => {
      await iv.getByRole("button", { name: "Copy invite link" }).click();
      const invite = await iv.evaluate(() => navigator.clipboard.readText());
      await cd.goto(invite);
      await signUp(cd, candidate.name);
      await expect(questionPanel(cd).getByRole("heading", { name: "Sum two numbers" })).toBeVisible();
      await expect(nav(cd)).toHaveCount(0);
      await expect(cd.locator("body")).not.toContainText("Multiply");
      await expect(cd.locator("body")).not.toContainText("Subtract");

      await replaceCode(cd, SUM);
      await cd.getByRole("button", { name: "Submit" }).click();
      await expect(results(cd).first()).toContainText("Accepted");
    });

    await test.step("questions can only be revealed in order", async () => {
      await iv.bringToFront();
      await navButton(iv, 3).click();
      await expect(questionPanel(iv).getByRole("heading", { name: "Subtract two numbers" })).toBeVisible();
      await expect(iv.getByRole("status").filter({ hasText: "can't see this question yet" })).toContainText("Reveal Q2 first.");
      await expect(iv.getByRole("button", { name: "Reveal to candidate" })).toHaveCount(0);
      // No custom cases on a question the candidate can't see: the shared doc would leak them early.
      const ivTests = iv.getByRole("region", { name: "Tests" });
      await ivTests.getByRole("tab", { name: "Testcase" }).click();
      await expect(ivTests.getByRole("button", { name: "Case 1" })).toBeVisible();
      await expect(ivTests.getByRole("button", { name: "Add a custom test case" })).toHaveCount(0);
    });

    await test.step("revealing Q2 takes the candidate to it, with its own starter code", async () => {
      await navButton(iv, 2).click();
      await iv.getByRole("button", { name: "Reveal to candidate" }).click();
      await expect(navButton(iv, 2)).toHaveAccessibleName("Q2: Multiply two numbers");
      await expect(iv.getByRole("button", { name: "Reveal to candidate" })).toHaveCount(0);

      await expect(questionPanel(cd).getByRole("heading", { name: "Multiply two numbers" })).toBeVisible();
      await expect(navButton(cd, 2)).toHaveAttribute("aria-current", "true");
      await expect(nav(cd).getByRole("button")).toHaveCount(2); // Q3 still doesn't exist for the candidate
      await expect(cd.locator("body")).not.toContainText("Subtract");
      await expect.poll(() => editorText(cd)).toBe("# multiply");

      await replaceCode(cd, PRODUCT);
      await cd.getByRole("button", { name: "Submit" }).click();
      // The results panel follows the question: only Q2's run, with Q2's single example as its test rows.
      await expect(resultsHeading(cd)).toHaveText("Results · Q2");
      await expect(results(cd)).toHaveCount(1);
      await expect(results(cd).first()).toContainText("Accepted"); // graded on Q2's tests
      await expect(testRows(cd)).toHaveCount(1);
      await expect(testRows(cd)).toContainText(["Example 1"]);
      await expect.poll(() => editorText(iv)).toBe(PRODUCT); // interviewer is on Q2 too: same buffer
      await expect(resultsHeading(iv)).toHaveText("Results · Q2");
      await expect(results(iv)).toHaveCount(1); // the interviewer's panel follows their own question
    });

    await test.step("each question keeps its own code", async () => {
      await navButton(cd, 1).click();
      await expect.poll(() => editorText(cd)).toBe(SUM);
      await expectUnchanged(() => editorText(iv), PRODUCT, 800); // the interviewer's Q2 view is unaffected

      // …and its own results: back on Q1, only Q1's run with Q1's two examples.
      await expect(resultsHeading(cd)).toHaveText("Results · Q1");
      await expect(results(cd)).toHaveCount(1);
      await expect(results(cd).first()).toContainText("Accepted");
      await expect(testRows(cd)).toHaveCount(2);
      await expect(results(iv)).toHaveCount(1); // the interviewer, still on Q2, still sees only Q2's run
      await expect(resultsHeading(iv)).toHaveText("Results · Q2");
    });

    await test.step("switching between questions with history keeps the Testcase tab", async () => {
      // Regression (PR #5 review): the other question's existing runs must not count as a new run.
      const panel = cd.getByRole("region", { name: "Tests" });
      const testcaseTab = panel.getByRole("tab", { name: "Testcase" });
      await testcaseTab.click();
      await expect(testcaseTab).toHaveAttribute("aria-selected", "true");
      await navButton(cd, 2).click(); // Q2 has a run
      await expect(questionPanel(cd).getByRole("heading", { name: "Multiply two numbers" })).toBeVisible();
      await expectUnchanged(async () => String(await testcaseTab.getAttribute("aria-selected")), "true", 800);
      await expect(panel.getByLabel("Case input")).toHaveText("2 3"); // Q2's case, not Q1's
      await navButton(cd, 1).click(); // and back: Q1 has a run too
      await expectUnchanged(async () => String(await testcaseTab.getAttribute("aria-selected")), "true", 800);
    });

    await test.step("a reveal missed while disconnected arrives on reconnect", async () => {
      await candidate.realtime.drop();
      await navButton(iv, 3).click();
      await iv.getByRole("button", { name: "Reveal to candidate" }).click();
      await expect(navButton(iv, 3)).toHaveAccessibleName("Q3: Subtract two numbers");
      await expectUnchanged(async () => String(await nav(cd).getByRole("button").count()), "2", 1000); // event lost

      candidate.realtime.restore();
      await expect(questionPanel(cd).getByRole("heading", { name: "Subtract two numbers" })).toBeVisible({ timeout: 30_000 });
      await expect(nav(cd).getByRole("button")).toHaveCount(3);
      await expect.poll(() => editorText(cd)).toBe("# subtract");
      await replaceCode(cd, DIFFERENCE);
      await cd.getByRole("button", { name: "Run" }).click();
      await expect(resultsHeading(cd)).toHaveText("Results · Q3");
      await expect(results(cd)).toHaveCount(1);
      await expect(results(cd).first()).toContainText("Accepted");
    });

    await test.step("after a reload everything is still there", async () => {
      await cd.reload();
      await expect(nav(cd).getByRole("button")).toHaveCount(3);
      // Loading history isn't a new run: the panel stays on Testcase until asked.
      const testcaseTab = cd.getByRole("region", { name: "Tests" }).getByRole("tab", { name: "Testcase" });
      await expectUnchanged(async () => String(await testcaseTab.getAttribute("aria-selected")), "true", 1500);
      await cd.getByRole("region", { name: "Tests" }).getByRole("tab", { name: "Test Result" }).click();
      await navButton(cd, 2).click();
      await expect.poll(() => editorText(cd)).toBe(PRODUCT);
      await expect(results(cd)).toHaveCount(1); // history re-fetched, still filed per question
      await expect(results(cd).first()).toContainText("Accepted");
      await navButton(cd, 1).click();
      await expect(results(cd)).toHaveCount(1);
      await expect(testRows(cd)).toHaveCount(2);
    });
  } finally {
    await interviewer.close();
    await candidate.close();
  }
});

/**
 * Regression: the reveal notification is lost (publish failed, and the reconciler never got to it
 * because the room ended right away — gateways stop reconciling reveals for ended rooms). The
 * candidate stays connected the whole time and must still end up with the final question list,
 * without reloading: `room:closed` makes the client re-fetch the room.
 */
test("a reveal whose notification is lost right before the session ends still reaches the candidate", async ({ browser }) => {
  const interviewer = await openAs(browser, "Iris Interviewer");
  const candidate = await openAs(browser, "Casey Candidate");
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await iv.goto("/");
    await signUp(iv, interviewer.name);
    await authorQuestion(iv, "Multiply two numbers", "# multiply\n", "2 3", "6");
    await iv.goto("/");
    const picked = iv.getByLabel("Interview questions").getByRole("listitem");
    await expect(picked).toHaveCount(1);
    await iv.getByRole("button", { name: "Add question" }).click(); // the other of {Sum, Multiply}
    await expect(picked).toHaveCount(2);
    const secondTitle = (await picked.nth(1).textContent())!.includes("Multiply") ? "Multiply two numbers" : "Sum two numbers";
    await iv.getByRole("button", { name: "Create room" }).click();
    await expect(iv).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);

    await iv.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await iv.evaluate(() => navigator.clipboard.readText());
    await cd.goto(invite);
    await signUp(cd, candidate.name);
    await expect(questionPanel(cd)).toBeVisible();
    await expect(nav(cd)).toHaveCount(0);
    await cd.evaluate(() => ((window as unknown as { e2eNoReload: boolean }).e2eNoReload = true));

    // Every reveal notification to the candidate is lost; their sockets stay connected.
    candidate.realtime.dropEvents("room:question_revealed");
    await iv.bringToFront();
    await navButton(iv, 2).click();
    await iv.getByRole("button", { name: "Reveal to candidate" }).click();
    await expect(navButton(iv, 2)).toHaveAccessibleName(`Q2: ${secondTitle}`);
    await expectUnchanged(async () => String(await nav(cd).count()), "0", 1000); // candidate didn't hear about it

    // …and the interviewer ends the session immediately.
    iv.once("dialog", (dialog) => dialog.accept());
    await iv.getByRole("button", { name: "End session" }).click();

    await expect(cd.getByText("This interview has ended.")).toBeVisible();
    await expect(nav(cd).getByRole("button")).toHaveCount(2);
    await expect(questionPanel(cd).getByRole("heading", { name: secondTitle })).toBeVisible();
    expect(await cd.evaluate(() => (window as unknown as { e2eNoReload?: boolean }).e2eNoReload)).toBe(true); // no reload happened
    await expect(cd.getByRole("button", { name: "Run" })).toBeDisabled();
  } finally {
    await interviewer.close();
    await candidate.close();
  }
});
