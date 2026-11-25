import { expect, test, type Page } from "@playwright/test";
import { appendLine, editorText, replaceCode, results, startInterview } from "./helpers";

/*
 * Room layout (ADR 0008): question | (code over tests), two resizable dividers. Layout is per browser:
 * each participant has their own context, so their own localStorage, like two people on two machines.
 */

type Divider = "question" | "test";
const separator = (page: Page, divider: Divider) => page.getByRole("separator", { name: `Resize ${divider} panel` });
const valueOf = async (page: Page, divider: Divider) => Number(await separator(page, divider).getAttribute("aria-valuenow"));
const monacoBox = async (page: Page) => (await page.locator(".monaco-editor").first().boundingBox())!;

/** Drag a divider by `delta` px (x for the question divider, y for the test divider); `during` runs mid-drag. */
async function drag(page: Page, divider: Divider, delta: number, during?: () => Promise<void>) {
  const box = (await separator(page, divider).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const to = (f: number) => (divider === "question" ? [x + delta * f, y] : [x, y + delta * f]) as [number, number];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(...to(0.5), { steps: 5 });
  await during?.();
  await page.mouse.move(...to(1), { steps: 5 });
  await page.mouse.up();
}

/** Tag the Monaco DOM node; if the editor is ever remounted, the tag disappears. */
const markEditor = (page: Page) =>
  page.locator(".monaco-editor").first().evaluate((el) => el.setAttribute("data-e2e-marker", "original"));
const editorNotRemounted = (page: Page) => expect(page.locator('.monaco-editor[data-e2e-marker="original"]')).toHaveCount(1);

test("panels resize by mouse and keyboard, the editor follows, and the layout is kept per participant", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const page = interviewer.page;
  try {
    await page.bringToFront();
    const code = await editorText(page);
    await markEditor(page);
    expect(await valueOf(page, "question")).toBe(420);
    expect(await valueOf(page, "test")).toBe(300);
    // Measure only once the header has its final content: the other participant's avatar arrives over
    // awareness, and on narrower fonts (Linux CI) it wraps the header onto a second row, which would
    // shrink the editor by a row after `before` was taken.
    await expect(page.locator(".presence .avatar")).toHaveCount(2);
    const before = await monacoBox(page);

    // Question divider 120 px right: question wider, Monaco narrower by the same amount.
    await drag(page, "question", 120);
    expect(await valueOf(page, "question")).toBe(540);
    await expect.poll(async () => (await monacoBox(page)).width).toBeCloseTo(before.width - 120, -1);

    // Test divider: ↑ moves it up = test panel taller, Monaco shorter. Home = minimum.
    await separator(page, "test").focus();
    await page.keyboard.press("ArrowUp");
    expect(await valueOf(page, "test")).toBe(316);
    await page.keyboard.press("Shift+ArrowUp");
    expect(await valueOf(page, "test")).toBe(380);
    await expect.poll(async () => (await monacoBox(page)).height).toBeCloseTo(before.height - 80, -1);
    await drag(page, "test", -40); // dragging up also grows it
    expect(await valueOf(page, "test")).toBe(420);
    await separator(page, "test").focus();
    await page.keyboard.press("Home");
    expect(await valueOf(page, "test")).toBe(140);

    // Minimums hold: question ≥ 260, and the editor keeps ≥ 380 px width / 160 px height.
    await drag(page, "question", -1000);
    expect(await valueOf(page, "question")).toBe(260);
    await separator(page, "question").focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await monacoBox(page)).width).toBeGreaterThanOrEqual(380 - 30);
    await separator(page, "test").focus();
    await page.keyboard.press("End");
    // Wait for the end state (a poll's first sample can come before the layout paints): the code pane
    // at exactly its 160 px minimum, and Monaco filling what its header, toolbar and footer leave.
    const codePane = page.getByRole("region", { name: "Code" });
    await expect.poll(async () => Math.round((await codePane.boundingBox())!.height)).toBe(160);
    const chrome = await codePane.evaluate((el) =>
      [".pane-head", ".pane-toolbar", ".pane-foot"].reduce((sum, sel) => sum + el.querySelector(sel)!.getBoundingClientRect().height, 0),
    );
    await expect.poll(async () => (await monacoBox(page)).height).toBeCloseTo(160 - 2 - chrome, -1); // 2 = pane borders
    expect((await monacoBox(page)).height).toBeGreaterThan(40); // still a usable few lines
    await page.keyboard.press("Home");
    await separator(page, "question").focus();
    await page.keyboard.press("Home");

    // Each pane scrolls on its own; the page itself doesn't scroll.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

    // Resizing never touched the shared code or remounted the editor. (Monaco only renders the lines
    // that fit, so wait for it to grow back before reading.)
    await expect.poll(() => editorText(page)).toBe(code);
    await editorNotRemounted(page);

    // Restored on reload.
    await page.reload();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "260");
    await expect(separator(page, "test")).toHaveAttribute("aria-valuenow", "140");

    // The candidate's layout is their own: untouched by the interviewer's resizing.
    await candidate.page.reload();
    await expect(separator(candidate.page, "question")).toHaveAttribute("aria-valuenow", "420");
    await expect(separator(candidate.page, "test")).toHaveAttribute("aria-valuenow", "300");

    // Reset layout → defaults, also after reload.
    const reset = page.getByRole("button", { name: "Reset layout" });
    await reset.click();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "420");
    await expect(separator(page, "test")).toHaveAttribute("aria-valuenow", "300");
    await expect(reset).toBeDisabled();
    await page.reload();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "420");
  } finally {
    await close();
  }
});

/**
 * A small window shows oversized saved sizes squeezed, without rewriting them: they come back when the
 * window grows. Resizing one divider in a squeezed window leaves the other exactly where it is.
 */
test("a small window squeezes saved sizes without losing them, and one divider never moves the other", async ({ browser }) => {
  const { interviewer, close } = await startInterview(browser);
  const page = interviewer.page;
  try {
    await page.bringToFront();
    await page.evaluate(() => localStorage.setItem("coderoom:room-layout:v2", JSON.stringify({ question: 900, tests: 900 })));
    await page.setViewportSize({ width: 950, height: 700 });
    await page.reload();
    await expect(separator(page, "question")).toBeVisible();
    expect(await valueOf(page, "question")).toBe(950 - 18 - 380); // leaves the editor its minimum width
    const t0 = await valueOf(page, "test");
    expect(t0).toBeLessThan(900);

    // Just squeezing loses nothing: a bigger window shows the saved sizes again (as far as they fit).
    await page.setViewportSize({ width: 1400, height: 1100 });
    await expect.poll(() => valueOf(page, "question")).toBe(900);
    expect(await valueOf(page, "test")).toBeGreaterThan(t0);

    // Back in the small window, an explicit resize of one divider leaves the other where it is.
    await page.setViewportSize({ width: 950, height: 700 });
    await expect.poll(() => valueOf(page, "question")).toBe(950 - 18 - 380); // squeezed again (width and height are measured together)
    const t1 = await valueOf(page, "test");
    await separator(page, "question").focus();
    await page.keyboard.press("Home");
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "260");
    expect(await valueOf(page, "test")).toBe(t1); // the other divider didn't move
  } finally {
    await close();
  }
});

test("typing continues while a divider is being dragged", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const page = candidate.page;
  try {
    await replaceCode(page, "print(1)");
    await markEditor(page);

    // Keystrokes typed while the mouse button is still held on a divider land in the editor.
    await drag(page, "question", 150, async () => {
      await expect(page.locator(".monaco-editor textarea").first()).toBeFocused(); // pressing the divider didn't steal focus
      await page.keyboard.insertText("\nprint(2)");
    });
    await page.keyboard.insertText("\nprint(3)");
    await drag(page, "test", -80);
    await appendLine(page, "print(4)");

    const expected = "print(1)\nprint(2)\nprint(3)\nprint(4)";
    await expect.poll(() => editorText(page)).toBe(expected);
    await expect.poll(() => editorText(interviewer.page)).toBe(expected); // still collaborating
    await editorNotRemounted(page);
  } finally {
    await close();
  }
});

test("the test panel shows example cases, then the result of a run", async ({ browser }) => {
  const { candidate, close } = await startInterview(browser);
  const page = candidate.page;
  try {
    const tests = page.getByRole("region", { name: "Tests" });
    await expect(tests.getByRole("tab", { name: "Testcase" })).toHaveAttribute("aria-selected", "true");
    await expect(tests.getByRole("button", { name: "Case 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(tests.getByLabel("Case input")).toHaveText("1 2");
    await expect(tests.getByLabel("Case expected output")).toHaveText("3");
    await tests.getByRole("button", { name: "Case 2" }).click();
    await expect(tests.getByLabel("Case input")).toHaveText("10 20");
    await expect(tests.getByLabel("Case expected output")).toHaveText("30");
    await expect(tests).toContainText("Submit also runs 2 hidden tests.");
    await expect(tests.getByRole("button", { name: "Case 3" })).toHaveCount(0); // hidden tests aren't cases

    // Running switches to Test Result.
    await replaceCode(page, "a, b = map(int, input().split())\nprint(a + b)");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(tests.getByRole("tab", { name: "Test Result" })).toHaveAttribute("aria-selected", "true");
    await expect(results(page).first()).toContainText("Accepted");

    // The status bar follows the cursor.
    await expect(page.getByRole("region", { name: "Code" })).toContainText(/Ln \d+, Col \d+/);
  } finally {
    await close();
  }
});

test("narrow screens use tabs without remounting the editor", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const page = candidate.page;
  try {
    await replaceCode(page, "import sys\nprint(sum(map(int, sys.stdin.read().split())))");
    const code = await editorText(page);
    await markEditor(page);

    await page.setViewportSize({ width: 700, height: 900 });
    const tabs = page.getByRole("tablist", { name: "Room panels" });
    await expect(tabs).toBeVisible();
    await expect(page.getByRole("separator")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset layout" })).toHaveCount(0);
    await expect(tabs.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("complementary", { name: "Question" })).toBeHidden();
    expect(await editorText(page)).toBe(code);
    await expect.poll(async () => (await monacoBox(page)).width).toBeGreaterThan(550); // the editor uses the full width

    // Run from the Code tab opens Tests on narrow screens.
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(tabs.getByRole("tab", { name: "Tests", exact: true })).toHaveAttribute("aria-selected", "true");

    // Keyboard tab navigation (←/→) and the panels behind the tabs.
    await tabs.getByRole("tab", { name: "Code", exact: true }).click();
    await tabs.getByRole("tab", { name: "Code", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.getByRole("tab", { name: "Question" })).toBeFocused();
    await expect(page.getByRole("complementary", { name: "Question" })).toBeVisible();
    await expect(page.locator(".monaco-editor")).toBeHidden();

    await tabs.getByRole("tab", { name: /Tests/ }).click();
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText("Accepted", { timeout: 30_000 });
    await expect(tabs.getByRole("tab", { name: "Tests", exact: true })).toBeVisible(); // seen → mark cleared

    // Typing from the other participant arrives while the editor tab is hidden.
    await appendLine(interviewer.page, "# hint from interviewer");
    await tabs.getByRole("tab", { name: "Code" }).click();
    await expect.poll(() => editorText(page)).toBe(`${code}\n# hint from interviewer`);

    // Back to wide: side-by-side again, same editor instance.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(tabs).toHaveCount(0);
    await expect(separator(page, "question")).toBeVisible();
    await expect(separator(page, "test")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Question" })).toBeVisible();
    await editorNotRemounted(page);
  } finally {
    await close();
  }
});
