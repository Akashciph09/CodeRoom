import { expect, test } from "@playwright/test";
import {
  appendLine,
  avatars,
  editorText,
  expectUnchanged,
  openAs,
  replaceCode,
  results,
  signUp,
  type Participant,
} from "./helpers";

const SOLUTION = "a, b = map(int, input().split())\nprint(a + b)";
const HINT = "# interviewer: what if the input has extra spaces?";

/**
 * One realistic interview, end to end, with two real users in two browser contexts:
 * create room → invite → join → collaborate → run/submit → role-specific results → end session.
 * Steps share state (room, users), so this is one test with named steps.
 */
test("interviewer and candidate run a full interview", async ({ browser, baseURL }) => {
  const interviewer = await openAs(browser, "Iris Interviewer");
  const candidate = await openAs(browser, "Casey Candidate");
  const people: Participant[] = [interviewer, candidate];
  let roomUrl = "";

  try {
    await test.step("interviewer signs up and opens a room", async () => {
      const { page } = interviewer;
      await page.goto("/");
      await signUp(page, interviewer.name);
      await expect(page.getByRole("heading", { name: "Start an interview" })).toBeVisible();
      await page.getByRole("button", { name: "Create room" }).click();
      await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
      roomUrl = page.url();

      await expect(page.locator(".badge.interviewer")).toBeVisible();
      await expect(page.getByText("live", { exact: true })).toBeVisible();
      // Starter code was seeded into the shared document.
      await expect.poll(() => editorText(page)).toContain("def solve");
      // Interviewers can't run code.
      await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);
    });

    let inviteLink = "";
    await test.step("interviewer copies the invite link", async () => {
      const { page } = interviewer;
      await page.getByRole("button", { name: "Copy invite link" }).click();
      await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
      inviteLink = await page.evaluate(() => navigator.clipboard.readText());
      expect(inviteLink).toMatch(new RegExp(`^${baseURL}/join/[A-Za-z0-9_-]+$`));
    });

    await test.step("candidate follows the invite, signs up and lands in the room", async () => {
      const { page } = candidate;
      await page.goto(inviteLink);
      await expect(page).toHaveURL(/\/login\?next=/); // invite survives the sign-in redirect
      await signUp(page, candidate.name);
      await expect(page).toHaveURL(roomUrl);
      await expect(page.locator(".badge.candidate")).toBeVisible();
      await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
      await expect.poll(() => editorText(page)).toContain("def solve");
    });

    await test.step("both see each other in the room", async () => {
      for (const p of people) {
        await expect(avatars(p.page)).toHaveCount(2);
        for (const other of people) {
          await expect(p.page.locator(`.presence .avatar[title^="${other.name}"]`)).toHaveCount(1);
        }
      }
    });

    await test.step("candidate's typing appears in the interviewer's editor", async () => {
      await replaceCode(candidate.page, SOLUTION);
      await expect.poll(() => editorText(interviewer.page)).toBe(SOLUTION);
    });

    await test.step("interviewer's typing appears in the candidate's editor", async () => {
      await appendLine(interviewer.page, HINT);
      await expect.poll(() => editorText(candidate.page)).toBe(`${SOLUTION}\n${HINT}`);
    });

    await test.step("candidate submits; each side sees its own view of the result", async () => {
      await candidate.page.getByRole("button", { name: "Submit" }).click();

      const mine = results(candidate.page).first();
      await expect(mine).toContainText("Accepted");
      await expect(mine).toContainText("hidden tests 2/2");
      await expect(mine.locator(".badge.hidden")).toHaveCount(0); // hidden tests never shown
      await expect(mine.getByRole("button", { name: /submitted code/ })).toHaveCount(0);

      const theirs = results(interviewer.page).first();
      await expect(theirs).toContainText("Accepted");
      await expect(theirs.locator(".badge.hidden")).toHaveCount(2); // interviewer sees hidden tests
      await theirs.getByRole("button", { name: "Show submitted code" }).click();
      await expect(theirs.locator(".code-snapshot")).toContainText("print(a + b)");
    });

    await test.step("language change syncs to the other participant", async () => {
      await candidate.page.getByRole("combobox").selectOption("javascript");
      await expect(interviewer.page.getByRole("combobox")).toHaveValue("javascript");
    });

    await test.step("an infinite loop is stopped by the sandbox", async () => {
      await replaceCode(candidate.page, "while (true) {}");
      await expect.poll(() => editorText(interviewer.page)).toBe("while (true) {}");
      await candidate.page.getByRole("button", { name: "Run" }).click();
      const run = results(candidate.page).first();
      await expect(run).toContainText("Time limit exceeded", { timeout: 30_000 });
      await expect(results(interviewer.page).first()).toContainText("Time limit exceeded");
    });

    await test.step("an outsider can't open the room", async () => {
      const outsider = await openAs(browser, "Olly Outsider");
      try {
        await outsider.page.goto(roomUrl);
        await signUp(outsider.page, outsider.name);
        await expect(outsider.page.getByText("You're not a participant in this room.")).toBeVisible();
        await expect(outsider.page.locator(".monaco-editor")).toHaveCount(0);
      } finally {
        await outsider.close();
      }
    });

    await test.step("interviewer ends the session; the candidate can no longer edit or run", async () => {
      const codeAtEnd = await editorText(interviewer.page);
      interviewer.page.once("dialog", (dialog) => dialog.accept());
      await interviewer.page.getByRole("button", { name: "End session" }).click();

      for (const p of people) {
        await expect(p.page.getByText("This interview has ended. The code is read-only.")).toBeVisible();
      }
      await expect(candidate.page.getByRole("button", { name: "Run" })).toBeDisabled();
      await expect(candidate.page.getByRole("button", { name: "Submit" })).toBeDisabled();
      await expect(interviewer.page.getByRole("button", { name: "End session" })).toHaveCount(0);

      // Typing is ignored locally, and nothing reaches the other side.
      await replaceCode(candidate.page, "SHOULD NOT APPEAR");
      await expectUnchanged(() => editorText(candidate.page), codeAtEnd);
      await expectUnchanged(() => editorText(interviewer.page), codeAtEnd);
    });

    await test.step("after a reload, the ended room still shows the final code and history", async () => {
      const { page } = candidate;
      await page.reload();
      await expect(page.getByText("This interview has ended. The code is read-only.")).toBeVisible();
      await expect.poll(() => editorText(page)).toBe("while (true) {}");
      await expect(results(page)).toHaveCount(2);
    });
  } finally {
    for (const p of people) await p.close();
  }
});

test("signed-out visitors are sent to sign-in", async ({ page }) => {
  await page.goto("/rooms/00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/login\?next=%2Frooms%2F/);
  await expect(page.getByRole("button", { name: "Sign in" }).last()).toBeVisible();
});
