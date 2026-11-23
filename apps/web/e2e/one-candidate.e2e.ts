import { expect, test } from "@playwright/test";
import { openAs, signUp, startInterview } from "./helpers";

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
    await expect(intruder.page.getByText(/This interview already has a candidate/)).toBeVisible();

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
