import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openAs, signUp } from "./helpers";

/*
 * "Your rooms" (ADR 0013): aligned columns Interview | Candidate | Your role | Status | Created | Action,
 * candidate details only on rows you interview, no scores (those are on the review page), search, and
 * compact cards on phones.
 */

const LONG_NAME = "Maximiliana Alexandrina Konstantinopoulou-Wetherby the Third";

/** Sign up with a very long email too (the shared helper's emails are short). */
async function signUpLong(page: Page, name: string) {
  const email = `e2e-${randomUUID().slice(0, 8)}-a-really-quite-long-mailbox-name-for-layout@very-long-subdomain.example.test`;
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: "Create account" }).first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(randomUUID());
  await page.locator("form").getByRole("button", { name: "Create account" }).last().click();
  await expect(page).not.toHaveURL(/\/login/);
  return email;
}

const table = (page: Page) => page.getByRole("table", { name: "Your rooms" });
const rowFor = (page: Page, roomPath: string) =>
  table(page).getByRole("row").filter({ has: page.locator(`a[href="${roomPath}"]`) });
const cell = (row: Locator, cls: string) => row.locator(`td.${cls}`);

test("rooms list: aligned columns, candidate details, ended status, search, phone cards, privacy", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const cd = await openAs(browser, LONG_NAME);
  try {
    // Room A: joined by a candidate with a long name and email.
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomA = new URL(iv.page.url()).pathname;
    await iv.page.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await iv.page.evaluate(() => navigator.clipboard.readText());
    await cd.page.goto(invite);
    const email = await signUpLong(cd.page, LONG_NAME);
    await expect(cd.page).toHaveURL(new RegExp(`${roomA}$`));

    // Room A ends; room B is created and nobody joins.
    iv.page.once("dialog", (d) => d.accept());
    await iv.page.getByRole("button", { name: "End session" }).click();
    await expect(iv.page.getByText("This interview has ended.")).toBeVisible();
    await iv.page.goto("/");
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomB = new URL(iv.page.url()).pathname;
    await iv.page.goto("/");

    // Columns.
    await expect(table(iv.page).getByRole("columnheader")).toHaveText(["Interview", "Candidate", "Your role", "Status", "Created", "Action"]);

    // Row A: candidate name with email below, compact badges, Ended, compact date with the full one available.
    const a = rowFor(iv.page, roomA);
    const b = rowFor(iv.page, roomB);
    await expect(cell(a, "cell-candidate")).toContainText(LONG_NAME);
    await expect(cell(a, "cell-candidate").locator(".candidate-email")).toHaveText(email);
    await expect(cell(a, "cell-role")).toHaveText("Interviewer");
    await expect(cell(a, "cell-status")).toHaveText("Ended");
    await expect(cell(b, "cell-status")).toHaveText("Open");
    const time = cell(a, "cell-created").locator("time");
    await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
    await expect(time.locator("[aria-hidden=true]")).toHaveText(/^\d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/);
    await expect(time).toHaveAttribute("title", /\d{4}.*\d{2}:\d{2}:\d{2}/); // full timestamp on hover…
    await expect(time.locator(".sr-only")).toHaveText(/\d{4}.*\d{2}:\d{2}:\d{2}/); // …and for screen readers
    await expect(cell(a, "cell-action").getByRole("link", { name: "Review" })).toHaveAttribute("href", `${roomA}/review`);
    await expect(table(iv.page)).not.toContainText(/Score|Grading|No Submit/); // scores live on the review page

    // Row B: nobody joined.
    await expect(cell(b, "cell-candidate")).toContainText("No candidate joined");
    await expect(cell(b, "cell-candidate").locator("[aria-hidden=true]")).toHaveText("—");

    // Long names/emails don't push other columns: the columns start at the same x in every row,
    // and the candidate text stays inside its column.
    for (const col of ["cell-role", "cell-status", "cell-created", "cell-action"]) {
      const xa = (await cell(a, col).boundingBox())!.x;
      const xb = (await cell(b, col).boundingBox())!.x;
      expect(Math.abs(xa - xb), col).toBeLessThan(1);
    }
    // The table never grows past its card (a long unbroken email would otherwise widen the column).
    const tableBox = (await table(iv.page).boundingBox())!;
    const cardBox = (await table(iv.page).locator("xpath=ancestor::section[1]").boundingBox())!;
    expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    expect(await iv.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const emailBox = (await cell(a, "cell-candidate").locator(".candidate-email").boundingBox())!;
    expect(emailBox.x + emailBox.width).toBeLessThanOrEqual((await cell(a, "cell-role").boundingBox())!.x + 1);

    // Search: by email, by name, by question, and no match.
    const search = iv.page.getByLabel("Search rooms");
    await search.fill("really-quite-long-mailbox");
    await expect(table(iv.page).getByRole("row")).toHaveCount(2); // header + room A
    await search.fill("konstantinopoulou");
    await expect(rowFor(iv.page, roomA)).toBeVisible();
    await expect(rowFor(iv.page, roomB)).toHaveCount(0);
    await search.fill("sum two");
    await expect(table(iv.page).getByRole("row")).toHaveCount(3);
    await search.fill("nobody-like-this");
    await expect(iv.page.getByText("No rooms match “nobody-like-this”.")).toBeVisible();
    await search.fill("");

    // Phone: compact cards, no horizontal page overflow, the full email readable, Review visible.
    await iv.page.setViewportSize({ width: 390, height: 844 });
    await expect(table(iv.page).getByRole("columnheader").first()).not.toBeInViewport();
    expect(await iv.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const phoneEmail = cell(a, "cell-candidate").locator(".candidate-email");
    expect(await phoneEmail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true); // wrapped, not clipped
    const phoneReview = cell(a, "cell-action").getByRole("link", { name: "Review" });
    await phoneReview.scrollIntoViewIfNeeded(); // the list sits below the "Start an interview" form
    await expect(phoneReview).toBeInViewport({ ratio: 1 });
    await iv.page.setViewportSize({ width: 1400, height: 900 });

    // The candidate's own list: their role, "You", no emails and no Review action.
    await cd.page.goto("/");
    const own = rowFor(cd.page, roomA);
    await expect(cell(own, "cell-role")).toHaveText("Candidate");
    await expect(cell(own, "cell-candidate")).toHaveText("You");
    await expect(table(cd.page)).not.toContainText("@");
    await expect(cell(own, "cell-action").getByRole("link")).toHaveCount(0);
  } finally {
    await iv.close();
    await cd.close();
  }
});

/**
 * Regression (PR #11 review): at intermediate widths the desktop columns' fixed budget can exceed the
 * table's width. The list must stay inside its card with no page overflow at every width — with an
 * older-year date, a very long name/email and a legacy "+1" room. The room data is shaped in the
 * response (no DB access from browser tests); everything rendered is real UI.
 */
test("the rooms list stays inside its card at every width", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomPath = new URL(iv.page.url()).pathname;

    await iv.page.route("**/rooms", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const rooms = (await response.json()) as Record<string, unknown>[];
      const shaped = rooms.map((r) => ({
        ...r,
        createdAt: "2025-01-05T09:04:00.000Z", // an older year → the longest date format
        candidates: [
          {
            name: "Maximiliana Alexandrina Konstantinopoulou-Wetherby the Third",
            email: "maximiliana.alexandrina.konstantinopoulou-wetherby.the-third@very-long-subdomain.example.test",
          },
          { name: "Sam Second", email: "sam.second@example.test" }, // legacy second candidate → "+1"
        ],
      }));
      await route.fulfill({ response, json: shaped });
    });
    await iv.page.goto("/");
    const row = rowFor(iv.page, roomPath);
    await expect(row).toContainText("+1");
    await expect(cell(row, "cell-created").locator("[aria-hidden=true]")).toHaveText(/^5 Jan 2025, \d{2}:\d{2}$/); // shown in local time

    const card = table(iv.page).locator("xpath=ancestor::section[1]");
    for (const width of [700, 768, 820, 960, 1280]) {
      await iv.page.setViewportSize({ width, height: 900 });
      await row.scrollIntoViewIfNeeded();
      const cardBox = (await card.boundingBox())!;
      const right = cardBox.x + cardBox.width + 1;
      for (const part of ["cell-interview", "cell-candidate", "cell-role", "cell-status", "cell-created", "cell-action"]) {
        const box = (await cell(row, part).boundingBox())!;
        expect(box.x + box.width, `${part} inside the card at ${width}px`).toBeLessThanOrEqual(right);
      }
      expect((await table(iv.page).boundingBox())!.x + (await table(iv.page).boundingBox())!.width, `table at ${width}px`).toBeLessThanOrEqual(right);
      expect(await iv.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no page overflow at ${width}px`).toBe(true);
      // Either cards, or a table whose two text columns get a readable width — never squeezed columns
      // (and never declared widths that add up to more than the table has).
      const tableMode = await table(iv.page).locator("thead").evaluate((el) => getComputedStyle(el).position !== "absolute");
      if (tableMode) {
        for (const part of ["cell-interview", "cell-candidate"]) {
          const w = (await cell(row, part).boundingBox())!.width;
          expect(w, `${part} readable width at ${width}px`).toBeGreaterThanOrEqual(140);
        }
      }
      // Each cell's content fits its column: nothing spills into the next column or gets cut
      // (a cell's own box always stays in the table, so measure its content instead).
      for (const part of ["cell-role", "cell-status", "cell-created", "cell-action"]) {
        const fits = await cell(row, part).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(fits, `${part} content fits its column at ${width}px`).toBe(true);
      }
      await expect(cell(row, "cell-action").getByRole("link", { name: "Review" })).toBeInViewport({ ratio: 1 });
    }
  } finally {
    await iv.close();
  }
});
