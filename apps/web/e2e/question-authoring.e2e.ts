import { expect, test, type Page } from "@playwright/test";
import { editorText, openAs, replaceCode, results, signUp, submissionCards } from "./helpers";

const TITLE = "Add two numbers (e2e)";
const STATEMENT = "Read two integers a and b from one line and print a + b.";
const CONSTRAINTS = "-1000 <= a, b <= 1000";
const STARTER = "a, b = map(int, input().split())\n# your code here";
const SOLUTION = "a, b = map(int, input().split())\nprint(a + b)";

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/**
 * Author a question end to end in the UI, interview with it, then publish a changed version and
 * check the running interview keeps the version it started with.
 */
test("author a question, interview with it, and keep the version pinned", async ({ browser }) => {
  const author = await openAs(browser, "Ada Author");
  const candidate = await openAs(browser, "Casey Candidate");
  const page = author.page;

  try {
    await test.step("author creates a question from My questions", async () => {
      await page.goto("/");
      await signUp(page, author.name);
      await page.getByRole("link", { name: "My questions" }).click();
      await expect(page.getByText("No questions yet")).toBeVisible();
      await page.getByRole("button", { name: "Create question" }).click();
      await expect(page).toHaveURL(/\/questions\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId("question-status")).toContainText("Draft — not available for interviews");
    });

    await test.step("fills in statement, constraints and starter code", async () => {
      await field(page, "Title").fill(TITLE);
      await field(page, "Problem statement").fill(STATEMENT);
      await field(page, "Constraints").fill(CONSTRAINTS);
      await field(page, "Python starter code").fill(STARTER);
    });

    await test.step("manages test cases: add, hide, reorder, remove", async () => {
      await page.getByRole("button", { name: "Add hidden test" }).click();
      await field(page, "Test 1 input").fill("5 5");
      await field(page, "Test 1 expected output").fill("10");
      await page.getByRole("button", { name: "Add public test" }).click();
      await field(page, "Test 2 input").fill("1 2");
      await field(page, "Test 2 expected output").fill("3");
      await page.getByRole("button", { name: "Add public test" }).click(); // extra one, removed below
      await expect(page.getByText("2 public · 1 hidden")).toBeVisible();

      // Public example first: move test 2 up.
      await page.getByRole("button", { name: "Move test 2 up" }).click();
      await expect(field(page, "Test 1 input")).toHaveValue("1 2");
      await expect(field(page, "Test 2 hidden")).toBeChecked();

      await page.getByRole("button", { name: "Remove test 3" }).click();
      await expect(page.getByText("1 public · 1 hidden")).toBeVisible();
    });

    await test.step("can't mark ready without a public test", async () => {
      await field(page, "Test 1 hidden").check(); // now both hidden
      await page.getByRole("button", { name: "Mark ready" }).click();
      await expect(page.getByRole("alert")).toContainText("Make at least one test public");
      await field(page, "Test 1 hidden").uncheck();
    });

    await test.step("saves a draft and previews exactly what the candidate sees", async () => {
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(page.getByText("Draft saved.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled(); // nothing unsaved

      await page.getByRole("button", { name: "Preview" }).click();
      const preview = page.getByRole("region", { name: "Candidate preview" });
      const q = preview.getByRole("complementary", { name: "Question" });
      await expect(q.getByRole("heading", { name: TITLE })).toBeVisible();
      await expect(q).toContainText(STATEMENT);
      await expect(q).toContainText(CONSTRAINTS);
      await expect(q).toContainText("Example 1");
      await expect(q).toContainText("1 hidden test");
      await expect(q).not.toContainText("5 5"); // hidden input never shown
      await expect(q).not.toContainText("Example 2");
      await expect(preview).toContainText("# your code here");
      await page.getByRole("button", { name: "Back to editing" }).click();
    });

    await test.step("marks it ready as version 1", async () => {
      await page.getByRole("button", { name: "Mark ready" }).click();
      await expect(page.getByText("Marked ready as version 1")).toBeVisible();
      await expect(page.getByTestId("question-status")).toContainText("Ready v1");
      await page.getByRole("link", { name: "← My questions" }).click();
      const row = page.getByRole("list", { name: "My questions" }).getByRole("listitem").filter({ hasText: TITLE });
      await expect(row).toContainText("Ready · v1");
      await row.getByRole("link", { name: TITLE }).click();
    });

    const questionUrl = page.url();
    let roomUrl = "";

    await test.step("starts an interview; the candidate sees the authored question", async () => {
      await page.getByRole("button", { name: "Start interview" }).click();
      await expect(page).toHaveURL(/\/rooms\//);
      roomUrl = page.url();
      await page.getByRole("button", { name: "Copy invite link" }).click();
      const invite = await page.evaluate(() => navigator.clipboard.readText());

      await candidate.page.goto(invite);
      await signUp(candidate.page, candidate.name);
      await expect(candidate.page).toHaveURL(roomUrl);
      const q = candidate.page.getByRole("complementary", { name: "Question" });
      await expect(q.getByRole("heading", { name: TITLE })).toBeVisible();
      await expect(q).toContainText(CONSTRAINTS);
      await expect(q).not.toContainText("5 5");
      await expect.poll(() => editorText(candidate.page)).toBe(STARTER); // the author's starter code

      await replaceCode(candidate.page, SOLUTION);
      await candidate.page.getByRole("button", { name: "Submit" }).click();
      const card = results(candidate.page).first();
      await expect(card).toContainText("Accepted");
      await candidate.page.getByRole("button", { name: "Submission results (Accepted)", exact: true }).click();
      await expect(submissionCards(candidate.page).first()).toContainText("1/1 hidden tests passed");
      await candidate.page.getByRole("button", { name: "Back to code" }).click();
    });

    await test.step("author publishes v2 with a different expected output", async () => {
      await page.goto(questionUrl);
      await expect(page.getByTestId("question-status")).toContainText("Used in 1 interview");
      await field(page, "Test 1 expected output").fill("4"); // deliberately different
      await expect(page.getByTestId("question-status")).toContainText("interviews keep using v1");
      await page.getByRole("button", { name: "Mark ready" }).click();
      await expect(page.getByText("Marked ready as version 2")).toBeVisible();
    });

    await test.step("the running interview keeps v1: same example, same grading", async () => {
      await candidate.page.reload();
      const q = candidate.page.getByRole("complementary", { name: "Question" });
      await expect(q.locator(".example pre").nth(1)).toHaveText("3"); // v1's expected output, not v2's "4"
      await candidate.page.getByRole("button", { name: "Submit" }).click();
      await expect(results(candidate.page)).toHaveCount(2);
      await expect(results(candidate.page).first()).toContainText("Accepted"); // graded on v1 tests
    });
  } finally {
    await author.close();
    await candidate.close();
  }
});
