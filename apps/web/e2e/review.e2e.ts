import { expect, test, type Page } from "@playwright/test";
import { openAs, replaceCode, results, signUp, startInterview } from "./helpers";

/*
 * Post-interview review and test score (ADR 0011).
 */

const WRONG = "a, b = map(int, input().split())\nprint(a - b)";
const SUM = "a, b = map(int, input().split())\nprint(a + b)";

async function submit(page: Page, code: string, count: number) {
  await replaceCode(page, code);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(results(page)).toHaveCount(count);
  await expect(results(page).first()).not.toContainText("Running", { timeout: 30_000 });
}

test("after the session, the interviewer reviews the score, timeline and diffs; candidates can't", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await submit(cd, WRONG, 1); // 0/4
    await submit(cd, SUM, 2); // 4/4 — the one that counts

    await iv.bringToFront();
    iv.once("dialog", (d) => d.accept());
    await iv.getByRole("button", { name: "End session" }).click();
    await expect(iv.getByText("This interview has ended.")).toBeVisible();
    const reviewUrl = `${iv.url()}/review`;

    // The room links to the review, in the same tab (sign-in is per tab, a new tab would be signed out).
    const reviewLink = iv.getByRole("link", { name: "Review" });
    await expect(reviewLink).toHaveAttribute("href", new URL(reviewUrl).pathname);
    await expect(reviewLink).not.toHaveAttribute("target", "_blank");

    await reviewLink.click();
    await expect(iv).toHaveURL(reviewUrl);
    await expect(iv.getByRole("heading", { name: "Interview review" })).toBeVisible();
    await expect(iv.getByText(/lasted \d+:\d{2}/)).toBeVisible();
    const casey = iv.getByRole("region", { name: "Candidate Casey Candidate" });
    await expect(casey.getByLabel("Test score")).toHaveText("100 / 100");
    await expect(casey.getByRole("table", { name: "Score breakdown" })).toContainText("4/4 tests");
    await expect(casey).toContainText("not a decision");

    const timeline = casey.getByLabel("Q1 timeline");
    await expect(timeline.getByRole("listitem")).toHaveCount(2);
    await expect(timeline.getByRole("listitem").nth(0)).toContainText("Wrong answer");
    await expect(timeline.getByRole("listitem").nth(0)).toContainText("0/4 tests (hidden 0/2)");
    await expect(timeline.getByRole("listitem").nth(1)).toContainText("4/4 tests (hidden 2/2)");
    await expect(timeline.getByRole("listitem").nth(1)).toContainText("counted");

    // How they fixed it: the diff between the two Submits.
    await timeline.getByRole("button", { name: "Diff vs previous Submit" }).click();
    const diff = casey.getByLabel("Diff vs previous Submit");
    await expect(diff).toContainText("- print(a - b)");
    await expect(diff).toContainText("+ print(a + b)");

    // Candidates can't see the review.
    await cd.goto(reviewUrl);
    await expect(cd.getByText("Only the interviewer can review this interview.")).toBeVisible();
    await expect(cd.getByLabel("Test score")).toHaveCount(0);

    // And it's reachable from the interviewer's room list.
    await iv.goto("/");
    await expect(iv.getByRole("link", { name: "Review" }).first()).toHaveAttribute("href", new URL(reviewUrl).pathname);
  } finally {
    await close();
  }
});

test("points set in the room picker are what the review uses", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await expect(iv.page.getByLabel("Q1 points")).toHaveCount(0); // equal weights unless asked
    await iv.page.getByLabel(/Set points per question/).check();
    await expect(iv.page.getByLabel("Q1 points")).toHaveValue("100"); // equal split of 100 by default
    await iv.page.getByLabel("Q1 points").fill("40");
    await iv.page.getByRole("button", { name: "Create room" }).click();
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);

    await iv.page.goto(`${iv.page.url()}/review`);
    const questions = iv.page.getByRole("region", { name: "Questions" });
    await expect(questions.getByRole("row").nth(1)).toContainText("40");
    await expect(iv.page.getByText("No candidate joined this interview.")).toBeVisible();
  } finally {
    await iv.close();
  }
});

/**
 * Regression (PR #8 review): the review must keep up with results that are still being graded —
 * a Submit landing while the review is open next to the live room (event path), and one still
 * grading when the session ended and the review was opened (polling path) — without a reload.
 */
test("the review updates as submissions finish, without a reload", async ({ browser }) => {
  const SLOW_SUM = "import time\ntime.sleep(1.2)\na, b = map(int, input().split())\nprint(a + b)";
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    const roomUrl = iv.url();
    const review = iv; // the interviewer opens the review while the room is still live
    await review.getByRole("link", { name: "Review" }).click();
    await expect(review).toHaveURL(`${roomUrl}/review`);
    const casey = review.getByRole("region", { name: "Candidate Casey Candidate" });
    await expect(casey.getByLabel("Test score")).toHaveText("0 / 100");
    const timeline = casey.getByLabel("Q1 timeline");
    await expect(timeline.getByRole("listitem")).toHaveCount(0);

    // Live room: a Submit appears on the open review by itself (room events).
    await submit(cd, WRONG, 1);
    await expect(timeline.getByRole("listitem")).toHaveCount(1);
    await expect(timeline.getByRole("listitem").first()).toContainText("Wrong answer");

    // A slow, correct Submit, then the session ends while it's still being graded.
    await cd.bringToFront();
    await replaceCode(cd, SLOW_SUM);
    await cd.getByRole("button", { name: "Submit" }).click();
    await expect(results(cd)).toHaveCount(2);
    await iv.bringToFront();
    await iv.goto(roomUrl);
    iv.once("dialog", (d) => d.accept());
    await iv.getByRole("button", { name: "End session" }).click();
    await expect(iv.getByText("This interview has ended.")).toBeVisible();

    // Open the review of the ended room while that Submit is still grading…
    await iv.getByRole("link", { name: "Review" }).click();
    await expect(timeline.getByRole("listitem").nth(1)).toContainText("Running…");
    // …and it catches up on its own.
    await expect(timeline.getByRole("listitem").nth(1)).toContainText("Accepted", { timeout: 20_000 });
    await expect(timeline.getByRole("listitem").nth(1)).toContainText("counted");
    await expect(casey.getByLabel("Test score")).toHaveText("100 / 100");
  } finally {
    await close();
  }
});
