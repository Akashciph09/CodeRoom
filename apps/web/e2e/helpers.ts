import { randomUUID } from "node:crypto";
import { expect, type Browser, type Page, type WebSocketRoute } from "@playwright/test";

export interface Participant {
  name: string;
  page: Page;
  /** Cut / restore this participant's realtime connections (editor + events). HTTP keeps working. */
  realtime: RealtimeSwitch;
  close: () => Promise<void>;
}

export interface RealtimeSwitch {
  /** Close every open realtime socket and refuse reconnects until `restore()`. */
  drop(): Promise<void>;
  restore(): void;
}

/**
 * Each participant gets their own browser context = their own storage = their own identity,
 * like two people on two machines. Clipboard access is granted for "Copy invite link".
 *
 * Realtime sockets are proxied through the test (routeWebSocket → connectToServer, messages pass
 * through untouched), so a test can drop the connection deterministically. Network-offline emulation
 * isn't used because it doesn't reliably close WebSockets that are already open.
 */
export async function openAs(browser: Browser, name: string): Promise<Participant> {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });

  let online = true;
  const open = new Set<WebSocketRoute>();
  await context.routeWebSocket(/\/(yjs\/|rooms\/[^/]+\/events)/, (ws) => {
    if (!online) {
      void ws.close({ code: 4000, reason: "e2e: realtime dropped" });
      return;
    }
    ws.connectToServer();
    open.add(ws);
    ws.onClose(() => open.delete(ws));
  });
  const realtime: RealtimeSwitch = {
    async drop() {
      online = false;
      await Promise.all([...open].map((ws) => ws.close({ code: 4000, reason: "e2e: realtime dropped" })));
      open.clear();
    },
    restore() {
      online = true;
    },
  };

  const page = await context.newPage();
  return { name, page, realtime, close: () => context.close() };
}

/** Interviewer creates a room, candidate joins via the invite link; both are in the live room. */
export async function startInterview(browser: Browser) {
  const interviewer = await openAs(browser, "Iris Interviewer");
  const candidate = await openAs(browser, "Casey Candidate");

  await interviewer.page.goto("/");
  await signUp(interviewer.page, interviewer.name);
  await interviewer.page.getByRole("button", { name: "Create room" }).click();
  await expect(interviewer.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  await interviewer.page.getByRole("button", { name: "Copy invite link" }).click();
  const invite = await interviewer.page.evaluate(() => navigator.clipboard.readText());

  await candidate.page.goto(invite);
  await signUp(candidate.page, candidate.name);
  await expect(candidate.page).toHaveURL(interviewer.page.url());
  for (const p of [interviewer, candidate]) await expect(liveStatus(p.page)).toHaveText("live");
  await expect.poll(() => editorText(candidate.page)).not.toBe(""); // starter code seeded

  return {
    interviewer,
    candidate,
    close: async () => {
      await interviewer.close();
      await candidate.close();
    },
  };
}

/** The "live" / "reconnecting…" label in the room's top bar. */
export const liveStatus = (page: Page) => page.locator(".topbar-center .status-dot + span");

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

/** Add a line at the end of the document (doesn't touch what others wrote). */
export async function appendLine(page: Page, line: string) {
  await page.bringToFront();
  await editor(page).click();
  await expect(page.locator(".monaco-editor textarea").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(`\n${line}`);
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
