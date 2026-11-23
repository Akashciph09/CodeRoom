import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openAs, replaceCode, results, signUp } from "./helpers";

/*
 * README screenshots, generated from a real interview driven through the UI (local stack only):
 *   pnpm --filter @coderoom/web screenshots      → docs/screenshots/*.png
 * Skipped in the normal e2e run.
 */
test.skip(!process.env.SCREENSHOTS, "Set SCREENSHOTS=1 (pnpm --filter @coderoom/web screenshots)");
test.setTimeout(240_000);

const OUT = path.resolve(process.cwd(), "../../docs/screenshots");
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const tests = (page: Page) => page.getByRole("region", { name: "Tests" });
const navButton = (page: Page, n: number) =>
  page.getByRole("navigation", { name: "Questions" }).getByRole("button", { name: new RegExp(`^Q${n}:`) });

const STATEMENT = `Given an array of n integers, find the largest sum of any non-empty contiguous subarray.

Input: the first line holds n; the second line holds the n integers.
Output: the maximum subarray sum.`;
const STARTER = "import sys\n\n\ndef max_subarray(nums: list[int]) -> int:\n    # TODO\n    return 0\n";
const BUGGY = `import sys

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))

best = cur = 0
for x in nums:
    cur = max(x, cur + x)
    best = max(best, cur)
print(best)`;
const KADANE = `import sys

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))

# Kadane: best sum of a subarray ending here, and overall
best = cur = nums[0]
for x in nums[1:]:
    cur = max(x, cur + x)
    best = max(best, cur)
print(best)`;
const SUM = "a, b = map(int, input().split())\nprint(a + b)";

/**
 * Put code in the editor by pasting, as a person would: typing multi-line Python through Monaco
 * auto-indents each new line on top of the typed spaces (that's why the tests use flat code).
 */
async function pasteCode(page: Page, code: string) {
  await page.bringToFront();
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.locator(".monaco-editor").first().click();
  await expect(page.locator(".monaco-editor textarea").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => page.locator(".monaco-editor .view-lines").first().innerText()).toContain("print(");
}

async function settle(page: Page, count: number) {
  await expect(results(page)).toHaveCount(count);
  await expect(results(page).first()).not.toContainText("Running", { timeout: 30_000 });
}

test("README screenshots", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const cd = await openAs(browser, "Casey Candidate");
  const ivp = iv.page;
  const cdp = cd.page;
  for (const p of [ivp, cdp]) await p.setViewportSize({ width: 1440, height: 900 });
  try {
    // 1. Question authoring
    await ivp.goto("/");
    await signUp(ivp, iv.name);
    await ivp.getByRole("link", { name: "My questions", exact: true }).click();
    await ivp.getByRole("button", { name: "Create question" }).click();
    await field(ivp, "Title").fill("Maximum Subarray Sum");
    await field(ivp, "Problem statement").fill(STATEMENT);
    await field(ivp, "Constraints").fill("1 <= n <= 10^5\n-10^9 <= nums[i] <= 10^9");
    await field(ivp, "Python starter code").fill(STARTER);
    const testCases: [string, string, boolean][] = [
      ["9\n-2 1 -3 4 -1 2 1 -5 4", "6", false],
      ["5\n1 2 3 4 5", "15", false],
      ["4\n-8 -3 -6 -2", "-2", true],
      ["1\n7", "7", true],
      ["6\n5 -9 6 -2 3 1", "8", true],
    ];
    for (const [i, [input, output, hidden]] of testCases.entries()) {
      await ivp.getByRole("button", { name: hidden ? "Add hidden test" : "Add public test" }).click();
      await field(ivp, `Test ${i + 1} input`).fill(input);
      await field(ivp, `Test ${i + 1} expected output`).fill(output);
    }
    await ivp.getByRole("button", { name: "Save draft" }).click();
    await expect(ivp.getByText("Draft saved.")).toBeVisible();
    await ivp.evaluate(() => window.scrollTo(0, 0));
    await shot(ivp, "question-editor", true);
    await ivp.getByRole("button", { name: "Mark ready" }).click();
    await expect(ivp.getByText("Marked ready as version 1")).toBeVisible();

    // 2. Starting a two-question interview with points
    await ivp.goto("/");
    const picked = ivp.getByLabel("Interview questions").getByRole("listitem");
    await expect(picked).toHaveCount(1);
    await ivp.getByRole("button", { name: "Add question" }).click();
    if (!(await picked.first().textContent())?.includes("Maximum")) await ivp.getByRole("button", { name: "Move Q2 up" }).click();
    await ivp.getByLabel(/Set points per question/).check();
    await ivp.getByLabel("Q1 points").fill("60");
    await ivp.getByLabel("Q2 points").fill("40");
    await ivp.getByRole("heading", { name: "Start an interview" }).click(); // no focus ring in the shot
    await shot(ivp, "home");
    await ivp.getByRole("button", { name: "Create room" }).click();
    await expect(ivp).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomUrl = ivp.url();
    await ivp.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await ivp.evaluate(() => navigator.clipboard.readText());

    await cdp.goto(invite);
    await signUp(cdp, cd.name);
    await expect(cdp).toHaveURL(roomUrl);

    // 3. A first attempt that misses the all-negative case; the interviewer proposes an edge case.
    await pasteCode(cdp, BUGGY);
    await cdp.getByRole("button", { name: "Submit" }).click();
    await settle(cdp, 1);
    await ivp.bringToFront();
    await tests(ivp).getByRole("tab", { name: "Testcase" }).click();
    await tests(ivp).getByRole("button", { name: "Add a custom test case" }).click();
    await ivp.getByLabel("New case input").fill("4\n-1 -2 -3 -4");
    await ivp.getByLabel("New case expected output").fill("-1");
    await ivp.getByRole("button", { name: "Add case" }).click();

    // 4. The candidate fixes it and looks at the shared case (candidate view).
    await pasteCode(cdp, KADANE);
    await tests(cdp).getByRole("tab", { name: "Testcase" }).click();
    await tests(cdp).getByRole("button", { name: "Custom 1", exact: true }).click();
    await shot(cdp, "room-candidate");

    // 5. Run (with the custom case) and Submit; the interviewer sees every test, hidden ones included.
    await cdp.getByRole("button", { name: "Run", exact: true }).click();
    await settle(cdp, 2);
    await cdp.getByRole("button", { name: "Submit" }).click();
    await settle(cdp, 3);
    await ivp.bringToFront();
    await tests(ivp).getByRole("tab", { name: "Test Result" }).click();
    await expect(results(ivp).first()).toContainText("Accepted");
    await shot(ivp, "room-interviewer");

    // 6. Second question, revealed by the interviewer; a phone-sized view of the candidate's room.
    await navButton(ivp, 2).click();
    await ivp.getByRole("button", { name: "Reveal to candidate" }).click();
    await expect(cdp.getByRole("navigation", { name: "Questions" }).getByRole("button")).toHaveCount(2);
    await replaceCode(cdp, SUM);
    await cdp.getByRole("button", { name: "Submit" }).click();
    await settle(cdp, 1);
    await cdp.setViewportSize({ width: 390, height: 844 });
    await expect(cdp.getByRole("tablist", { name: "Room panels" })).toBeVisible();
    await shot(cdp, "mobile");

    // 7. End the session and review.
    await ivp.bringToFront();
    ivp.once("dialog", (d) => d.accept());
    await ivp.getByRole("button", { name: "End session" }).click();
    await expect(ivp.getByText("This interview has ended.")).toBeVisible();
    await ivp.getByRole("link", { name: "Review" }).click();
    const casey = ivp.getByRole("region", { name: "Candidate Casey Candidate" });
    await expect(casey.getByLabel("Test score")).toHaveText("100 / 100");
    await casey.getByLabel("Q1 timeline").getByRole("button", { name: "Diff vs previous Submit" }).click();
    await shot(ivp, "review", true);
  } finally {
    await iv.close();
    await cd.close();
  }
});
