import { expect, test, type Page } from "@playwright/test";
import { appendLine, editorText, expectUnchanged, replaceCode, results, startInterview } from "./helpers";

/*
 * Resizable room panels (ADR 0008). Layout is per browser: each participant has their own context,
 * so their own localStorage, like two people on two machines.
 */

const separator = (page: Page, panel: "question" | "results") =>
  page.getByRole("separator", { name: `Resize ${panel} panel` });
const valueOf = async (page: Page, panel: "question" | "results") =>
  Number(await separator(page, panel).getAttribute("aria-valuenow"));
const monacoWidth = async (page: Page) => (await page.locator(".monaco-editor").first().boundingBox())!.width;

/** Drag a separator horizontally by `dx` pixels with the mouse; `during` runs while the button is held. */
async function drag(page: Page, panel: "question" | "results", dx: number, during?: () => Promise<void>) {
  const box = (await separator(page, panel).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await during?.();
  await page.mouse.move(x + dx, y, { steps: 5 });
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
    expect(await valueOf(page, "question")).toBe(320);
    expect(await valueOf(page, "results")).toBe(360);
    const editorBefore = await monacoWidth(page);

    // Drag the question divider 120 px right: the question grows, Monaco shrinks to fit its column.
    await drag(page, "question", 120);
    expect(await valueOf(page, "question")).toBe(440);
    await expect.poll(() => monacoWidth(page)).toBeCloseTo(editorBefore - 120, -1);

    // Keyboard: ← on the results divider moves it left = results grows by one step; Home = its minimum.
    await separator(page, "results").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await valueOf(page, "results")).toBe(376);
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await valueOf(page, "results")).toBe(440);
    await page.keyboard.press("Home");
    expect(await valueOf(page, "results")).toBe(260);

    // Minimums hold: question can't go below 220, and the editor keeps at least 320 px.
    await drag(page, "question", -1000);
    expect(await valueOf(page, "question")).toBe(220);
    await separator(page, "results").focus();
    await page.keyboard.press("End");
    await expect.poll(() => monacoWidth(page)).toBeGreaterThanOrEqual(320 - 2);
    const maxResults = await valueOf(page, "results");
    await page.keyboard.press("Home");

    // Each panel scrolls on its own; the page itself doesn't scroll.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

    // Resizing never touched the shared code or remounted the editor.
    expect(await editorText(page)).toBe(code);
    await editorNotRemounted(page);

    // Restored on reload.
    await page.reload();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "220");
    await expect(separator(page, "results")).toHaveAttribute("aria-valuenow", "260");
    expect(maxResults).toBeGreaterThan(260);

    // The candidate's layout is their own: untouched by the interviewer's resizing.
    await candidate.page.reload();
    await expect(separator(candidate.page, "question")).toHaveAttribute("aria-valuenow", "320");
    await expect(separator(candidate.page, "results")).toHaveAttribute("aria-valuenow", "360");

    // Reset layout → defaults, also after reload.
    const reset = page.getByRole("button", { name: "Reset layout" });
    await reset.click();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "320");
    await expect(separator(page, "results")).toHaveAttribute("aria-valuenow", "360");
    await expect(reset).toBeDisabled();
    await page.reload();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "320");
  } finally {
    await close();
  }
});

/**
 * Regression: at 900–1000px saved preferences can be larger than the room fits, so they're displayed
 * squeezed. Resizing one panel must not move the other (it used to: the hook saved the new width next to
 * the other panel's oversized preference, and the next render re-fitted both).
 */
test("at 950px with oversized saved sizes, resizing one panel leaves the other where it is", async ({ browser }) => {
  const { interviewer, close } = await startInterview(browser);
  const page = interviewer.page;
  try {
    await page.bringToFront();
    await page.setViewportSize({ width: 950, height: 800 });
    await page.evaluate(() => localStorage.setItem("coderoom:room-layout:v1", JSON.stringify({ question: 600, results: 600 })));
    await page.reload();
    await expect(separator(page, "question")).toBeVisible();
    const q0 = await valueOf(page, "question");
    const r0 = await valueOf(page, "results");
    expect(q0 + r0).toBe(950 - 12 - 320); // squeezed to leave the editor its minimum

    // Home on the question divider: question → minimum, results unchanged.
    await separator(page, "question").focus();
    await page.keyboard.press("Home");
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "220");
    await expectUnchanged(async () => String(await valueOf(page, "results")), String(r0), 500);

    // Drag the results divider right (results shrinks): question unchanged.
    await drag(page, "results", 40);
    expect(await valueOf(page, "results")).toBe(r0 - 40);
    await expectUnchanged(async () => String(await valueOf(page, "question")), "220", 500);

    // Results to its maximum, then double-click the question divider (reset to default 320). There's no
    // room for 320, so the question stays as wide as fits — and results doesn't shrink to make room.
    await separator(page, "results").focus();
    await page.keyboard.press("End");
    const rMax = await valueOf(page, "results");
    expect(rMax).toBe(950 - 12 - 320 - 220);
    await separator(page, "question").dblclick();
    await expectUnchanged(async () => `${await valueOf(page, "question")}/${await valueOf(page, "results")}`, `220/${rMax}`, 500);

    // With room for it, double-click restores the default width; results still doesn't move.
    await separator(page, "results").focus();
    await page.keyboard.press("Home");
    await separator(page, "question").dblclick();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "320");
    await expectUnchanged(async () => String(await valueOf(page, "results")), "260", 500);

    // What was saved is what was shown: same layout after a reload.
    await page.reload();
    await expect(separator(page, "question")).toHaveAttribute("aria-valuenow", "320");
    await expect(separator(page, "results")).toHaveAttribute("aria-valuenow", "260");
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

    // Keystrokes typed while the mouse button is still held on the divider land in the editor.
    await drag(page, "question", 150, async () => {
      await expect(page.locator(".monaco-editor textarea").first()).toBeFocused(); // pressing the divider didn't steal focus
      await page.keyboard.insertText("\nprint(2)");
    });
    await page.keyboard.insertText("\nprint(3)");
    await drag(page, "results", -80);
    await appendLine(page, "print(4)");

    const expected = "print(1)\nprint(2)\nprint(3)\nprint(4)";
    await expect.poll(() => editorText(page)).toBe(expected);
    await expect.poll(() => editorText(interviewer.page)).toBe(expected); // still collaborating
    await editorNotRemounted(page);
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
    await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("complementary", { name: "Question" })).toBeHidden();
    expect(await editorText(page)).toBe(code);
    await expect.poll(() => monacoWidth(page)).toBeGreaterThan(600); // the editor uses the full width

    // Run from the Code tab: the Results tab marks the new result.
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Results \(new\)/ })).toBeVisible();

    // Keyboard tab navigation (←/→) and the panels behind the tabs.
    await page.getByRole("tab", { name: "Code" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Question" })).toBeFocused();
    await expect(page.getByRole("complementary", { name: "Question" })).toBeVisible();
    await expect(page.locator(".monaco-editor")).toBeHidden();

    await page.getByRole("tab", { name: /Results/ }).click();
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText("Accepted", { timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Results", exact: true })).toBeVisible(); // seen → mark cleared

    // Typing from the other participant arrives while the editor tab is hidden.
    await appendLine(interviewer.page, "# hint from interviewer");
    await page.getByRole("tab", { name: "Code" }).click();
    await expect.poll(() => editorText(page)).toBe(`${code}\n# hint from interviewer`);

    // Back to wide: three columns again, same editor instance.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(tabs).toHaveCount(0);
    await expect(separator(page, "question")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Question" })).toBeVisible();
    await editorNotRemounted(page);
  } finally {
    await close();
  }
});
