import { expect, test } from "@playwright/test";
import { openAs, signUp } from "./helpers";

/** Room names (ADR 0014): set when creating, renamed in the room, shown to the interviewer only. */
test("the interviewer names, renames and finds a room; the candidate never sees the name", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const cd = await openAs(browser, "Casey Candidate");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await iv.page.getByLabel("Room name").fill("Backend interview");
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomPath = new URL(iv.page.url()).pathname;
    const topbar = iv.page.locator(".topbar");
    await expect(topbar.locator(".room-name-text")).toHaveText("Backend interview");

    // The candidate joins: no name anywhere on their screen.
    await iv.page.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await iv.page.evaluate(() => navigator.clipboard.readText());
    await cd.page.goto(invite);
    await signUp(cd.page, cd.name);
    await expect(cd.page.getByRole("button", { name: "Submit" })).toBeVisible();
    await expect(cd.page.locator("body")).not.toContainText("Backend interview");
    await expect(cd.page.getByRole("button", { name: /Rename room|Name this room/ })).toHaveCount(0);

    // Rename in the room (Escape cancels, Save applies).
    await iv.page.bringToFront();
    await iv.page.getByRole("button", { name: "Rename room" }).click();
    await iv.page.locator(".topbar").getByLabel("Room name").fill("Something else");
    await iv.page.keyboard.press("Escape");
    await expect(topbar.locator(".room-name-text")).toHaveText("Backend interview");
    await iv.page.getByRole("button", { name: "Rename room" }).click();
    await iv.page.locator(".topbar").getByLabel("Room name").fill("SRE interview");
    await iv.page.getByRole("button", { name: "Save" }).click();
    await expect(topbar.locator(".room-name-text")).toHaveText("SRE interview");
    await iv.page.reload();
    await expect(topbar.locator(".room-name-text")).toHaveText("SRE interview"); // saved

    // The top bar never overflows with the name control, viewing or renaming: it wraps instead.
    for (const width of [1280, 1100]) {
      await iv.page.setViewportSize({ width, height: 800 });
      for (const renaming of [false, true]) {
        if (renaming) await iv.page.getByRole("button", { name: "Rename room" }).click();
        const fits = await topbar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(fits, `top bar fits at ${width}px${renaming ? " while renaming" : ""}`).toBe(true);
        if (renaming) await iv.page.keyboard.press("Escape");
      }
    }
    await iv.page.setViewportSize({ width: 1400, height: 900 });

    // The Interview cell shows only the room name, and search finds it.
    await iv.page.goto("/");
    const row = iv.page.getByRole("table", { name: "Your rooms" }).getByRole("row").filter({ has: iv.page.locator(`a[href="${roomPath}"]`) });
    await expect(row.locator(`a[href="${roomPath}"]`)).toHaveText("SRE interview");
    await expect(row.getByRole("cell").first()).toHaveText("SRE interview");
    await iv.page.getByLabel("Search rooms").fill("sre");
    await expect(row).toBeVisible();

    // The review shows it too.
    await iv.page.goto(`${roomPath}/review`);
    await expect(iv.page.locator(".review-room-name")).toHaveText("SRE interview");

    // The candidate's list still shows only the question.
    await cd.page.goto("/");
    const cdRow = cd.page.getByRole("table", { name: "Your rooms" }).getByRole("row").filter({ has: cd.page.locator(`a[href="${roomPath}"]`) });
    await expect(cdRow.locator(`a[href="${roomPath}"]`)).toHaveText("Sum two numbers");
    await expect(cd.page.locator("body")).not.toContainText("SRE interview");
  } finally {
    await iv.close();
    await cd.close();
  }
});

/**
 * Regression (PR #13 review): while a rename is saving, the form can't be cancelled, re-opened or
 * edited, so a slow response can't close (and lose) a newer edit.
 */
test("a rename that's still saving can't be cancelled or edited", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const topbar = iv.page.locator(".topbar");

    // Hold the PATCH response (the rename itself reaches the server) until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    await iv.page.route("**/rooms/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
    });

    await iv.page.getByRole("button", { name: "Name this room" }).click();
    const input = topbar.getByLabel("Room name");
    await input.fill("Backend interview");
    await iv.page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => held).toBe(true);

    // While saving: the field, Cancel and Escape do nothing.
    await expect(input).not.toBeEditable();
    await expect(iv.page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await input.press("Escape");
    await expect(input).toBeVisible(); // still open — Escape didn't close it mid-save

    release();
    await expect(topbar.locator(".room-name-text")).toHaveText("Backend interview");
    await expect(topbar.getByLabel("Room name")).toHaveCount(0);
  } finally {
    await iv.close();
  }
});

/** Regression (PR #13 review): an 80-character unbroken name wraps on the review page instead of overflowing. */
test("a long unbroken room name wraps on the review page", async ({ browser }) => {
  const LONG = "W".repeat(80);
  const iv = await openAs(browser, "Iris Interviewer");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await iv.page.getByLabel("Room name").fill(LONG);
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    await iv.page.goto(`${iv.page.url()}/review`);
    for (const width of [390, 768]) {
      await iv.page.setViewportSize({ width, height: 844 });
      const name = iv.page.locator(".review-room-name");
      await expect(name).toHaveText(LONG);
      const box = (await name.boundingBox())!;
      expect(box.x + box.width, `name inside the viewport at ${width}px`).toBeLessThanOrEqual(width);
      expect(await iv.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no page overflow at ${width}px`).toBe(true);
    }
  } finally {
    await iv.close();
  }
});
