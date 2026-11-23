import { expect, test, type Page } from "@playwright/test";
import { openAs, signIn, signUp } from "./helpers";

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function newQuestion(page: Page) {
  await page.getByRole("link", { name: "My questions" }).click();
  await page.getByRole("button", { name: "Create question" }).click();
  await expect(page).toHaveURL(/\/questions\/[0-9a-f-]{36}$/);
  return page.url();
}

/**
 * Edits typed while a save request is in flight must survive the response. The save's response is
 * held (the request itself reaches the server normally) while the author keeps typing.
 */
test("edits typed while a save is in flight are kept", async ({ browser }) => {
  const author = await openAs(browser, "Ada Author");
  const { page } = author;
  try {
    await page.goto("/");
    await signUp(page, author.name);
    const questionUrl = await newQuestion(page);

    await field(page, "Problem statement").fill("Part one.");

    // Hold the PUT /draft response until we say so.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    await page.route("**/questions/*/draft", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch(); // the save really happens on the server
      held = true;
      await gate;
      await route.fulfill({ response });
    });

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(() => held).toBe(true); // server has saved "Part one."; response not delivered yet

    const statement = field(page, "Problem statement");
    await statement.press("End");
    await statement.pressSequentially(" Part two.");
    release();

    await expect(page.getByText("Draft saved.")).toBeVisible();
    await expect(statement).toHaveValue("Part one. Part two."); // not rolled back to the saved text
    await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled(); // still unsaved

    await page.unroute("**/questions/*/draft");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await page.goto(questionUrl);
    await expect(field(page, "Problem statement")).toHaveValue("Part one. Part two.");
  } finally {
    await author.close();
  }
});

/**
 * The same author edits one question in two windows. The window that saves second is working from a
 * stale revision: it must get a conflict instead of silently overwriting the other window's save.
 */
test("a stale window gets a conflict instead of overwriting the draft", async ({ browser }) => {
  const one = await openAs(browser, "Ada (window 1)");
  const two = await openAs(browser, "Ada (window 2)");
  try {
    await one.page.goto("/");
    const creds = await signUp(one.page, "Ada Author");
    const questionUrl = await newQuestion(one.page);
    await field(one.page, "Title").fill("Original");
    await one.page.getByRole("button", { name: "Save draft" }).click();
    await expect(one.page.getByText("Draft saved.")).toBeVisible();

    // Window 2 opens the same draft.
    await two.page.goto(questionUrl);
    await signIn(two.page, creds);
    await expect(field(two.page, "Title")).toHaveValue("Original");

    // Window 1 saves first…
    await field(one.page, "Title").fill("Title from window 1");
    await one.page.getByRole("button", { name: "Save draft" }).click();
    await expect(one.page.getByText("Draft saved.")).toBeVisible();

    // …so window 2's save is stale.
    await field(two.page, "Problem statement").fill("Statement from window 2");
    await two.page.getByRole("button", { name: "Save draft" }).click();
    const banner = two.page.getByRole("alert", { name: "Draft conflict" });
    await expect(banner).toContainText("changed in another tab or window");
    await expect(field(two.page, "Problem statement")).toHaveValue("Statement from window 2"); // not lost locally

    // Mark ready from the stale window is refused too.
    await two.page.getByRole("button", { name: "Mark ready" }).click();
    await expect(banner).toBeVisible();

    // Nothing was overwritten on the server.
    await one.page.reload();
    await expect(field(one.page, "Title")).toHaveValue("Title from window 1");
    await expect(field(one.page, "Problem statement")).toHaveValue("");
    await expect(one.page.getByTestId("question-status")).toContainText("Draft"); // not published

    // Window 2 can recover by loading the latest version.
    await banner.getByRole("button", { name: "Reload latest" }).click();
    await expect(field(two.page, "Title")).toHaveValue("Title from window 1");
    await expect(banner).toHaveCount(0);
  } finally {
    await one.close();
    await two.close();
  }
});
