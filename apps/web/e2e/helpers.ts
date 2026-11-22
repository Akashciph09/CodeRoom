import { randomUUID } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";

export interface Participant {
  name: string;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Each participant gets their own browser context = their own storage = their own identity,
 * like two people on two machines. Clipboard access is granted for "Copy invite link".
 */
export async function openAs(browser: Browser, name: string): Promise<Participant> {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  return { name, page, close: () => context.close() };
}

/** Sign up a throwaway user on the (already displayed) sign-in page. Local Supabase only. */
export async function signUp(page: Page, name: string) {
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: "Create account" }).first().click(); // the tab
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`e2e-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByLabel("Password").fill(randomUUID());
  await page.locator("form").getByRole("button", { name: "Create account" }).last().click(); // submit
  await expect(page).not.toHaveURL(/\/login/);
}

// --- Monaco ------------------------------------------------------------------------------------

const editor = (page: Page) => page.locator(".monaco-editor").first();

/**
 * Replace the whole shared document, as a user would (select all + type).
 * With several contexts open only one page has focus, and keystrokes sent to an unfocused page
 * vanish silently — which would make "typing is ignored" assertions pass for the wrong reason.
 * So bring the page forward and assert the editor really has focus before typing.
 */
export async function replaceCode(page: Page, code: string) {
  await page.bringToFront();
  await editor(page).click();
  await expect(page.locator(".monaco-editor textarea").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  // insertText avoids Monaco's auto-closing brackets/auto-indent mangling typed code.
  await page.keyboard.insertText(code);
}

/** The editor's visible text (Monaco renders spaces as NBSP). */
export async function editorText(page: Page) {
  const text = await page.locator(".monaco-editor .view-lines").first().innerText();
  return text.replace(/ /g, " ").trim();
}

/**
 * Assert that something does NOT change. `expect.poll` can't do this: it passes on the first matching
 * sample, which may be taken before a change has even rendered (Monaco paints on the next frame).
 * Here every sample over `forMs` must match.
 */
export async function expectUnchanged(read: () => Promise<string>, expected: string, forMs = 1500) {
  const deadline = Date.now() + forMs;
  do {
    expect(await read()).toBe(expected);
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
}

export const results = (page: Page) => page.locator(".results-panel .submission");
export const avatars = (page: Page) => page.locator(".presence .avatar");
