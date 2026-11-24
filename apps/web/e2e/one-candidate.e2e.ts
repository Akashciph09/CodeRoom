import { expect, test } from "@playwright/test";
import { addInterviewQuestion, createInterviewRoom, openAs, signUp, startInterview } from "./helpers";

/** One interviewer, one candidate per room (ADR 0012): a forwarded invite link doesn't let anyone else in. */
test("a third person with the invite link is turned away; the candidate can rejoin", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const intruder = await openAs(browser, "Ivan Intruder");
  try {
    const roomUrl = interviewer.page.url();
    await interviewer.page.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await interviewer.page.evaluate(() => navigator.clipboard.readText());

    await intruder.page.goto(invite);
    await signUp(intruder.page, intruder.name);
    // The full explanation is only shown when the API's structured `room_full` code is recognised.
    await expect(intruder.page.getByText(/ask the interviewer for your own interview link/)).toBeVisible();

    // Going to the room directly doesn't work either.
    await intruder.page.goto(roomUrl);
    await expect(intruder.page.getByText("You're not a participant in this room.")).toBeVisible();
    await expect(intruder.page.locator(".monaco-editor")).toHaveCount(0);

    // The interviewer never sees them; the candidate can open the link again and lands back in the room.
    await expect(interviewer.page.locator(".presence .avatar")).toHaveCount(2);
    await candidate.page.goto(invite);
    await expect(candidate.page).toHaveURL(roomUrl);
    await expect(candidate.page.getByRole("button", { name: "Submit" })).toBeVisible();
  } finally {
    await intruder.close();
    await close();
  }
});

/**
 * Regression (PR #10 review): the interviewer opening their own invite link (e.g. to check it) must not
 * be told the room is full — they're taken to their room, and the candidate seat stays free.
 */
test("the interviewer opening their own invite link goes to their room; the seat stays free", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const cd = await openAs(browser, "Casey Candidate");
  try {
    await iv.page.goto("/");
    await signUp(iv.page, iv.name);
    await addInterviewQuestion(iv.page);
    await createInterviewRoom(iv.page);
    await expect(iv.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    const roomUrl = iv.page.url();
    await iv.page.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await iv.page.evaluate(() => navigator.clipboard.readText());

    await iv.page.goto(invite); // nobody has joined yet
    await expect(iv.page).toHaveURL(roomUrl);
    await expect(iv.page.getByText(/already has a candidate/)).toHaveCount(0);
    await expect(iv.page.locator(".badge.interviewer")).toBeVisible(); // still the interviewer

    // The seat is still free for the real candidate.
    await cd.page.goto(invite);
    await signUp(cd.page, cd.name);
    await expect(cd.page).toHaveURL(roomUrl);
    await expect(cd.page.getByRole("button", { name: "Submit" })).toBeVisible();
  } finally {
    await iv.close();
    await cd.close();
  }
});
