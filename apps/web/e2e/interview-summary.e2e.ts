import { expect, test } from "@playwright/test";
import type { InterviewSummaryDraft } from "@coderoom/shared";
import { addInterviewQuestion, createInterviewRoom, openAs, signUp } from "./helpers";

test("interviewer summary persists on return until explicitly discarded", async ({ browser }) => {
  const { page, name, close } = await openAs(browser, "Iris Interviewer");
  try {
    await page.goto("/");
    await signUp(page, name);
    await addInterviewQuestion(page);
    await createInterviewRoom(page);
    await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    await page.getByRole("tab", { name: "Notes" }).click();
    await page.getByRole("textbox", { name: "New note" }).fill("Clarified input format.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByRole("region", { name: "Tests" }).getByText("Clarified input format.")).toBeVisible();
    let anchor = "";
    let saved: InterviewSummaryDraft | null = null;
    await page.route("**/review/summary", async (route) => {
      switch (route.request().method()) {
        case "POST":
          saved = { revision: 1, items: [{
            section: "went_well",
            text: "The interviewer noted a clarification about the input.",
            citations: [{ anchor, label: "Note 1" }],
          }] };
          break;
        case "PUT":
          if (!saved) throw new Error("Missing draft in test fixture");
          saved = { revision: 2, items: saved.items.map((item, i) => ({ ...item, text: route.request().postDataJSON().texts[i] })) };
          break;
        case "DELETE":
          saved = null;
          await route.fulfill({ status: 204 });
          return;
      }
      await route.fulfill({ json: saved });
    });
    await page.getByRole("link", { name: "Review" }).click();
    const source = page.getByRole("region", { name: "Notes" }).getByRole("listitem");
    anchor = (await source.getAttribute("id"))!;
    expect(anchor).toMatch(/^note-/);
    const card = page.getByRole("region", { name: "Interview summary" });
    await card.getByRole("button", { name: "Draft a summary" }).click();
    const draft = card.getByRole("textbox", { name: "What went well, point 1" });
    await expect(draft).toHaveValue("The interviewer noted a clarification about the input.");
    await card.getByRole("link", { name: "Note 1" }).click();
    await expect(source).toBeInViewport();
    expect(new URL(page.url()).hash).toBe(`#${anchor}`);
    await page.getByRole("link", { name: "← Back to the room" }).click();
    await page.getByRole("link", { name: "Review" }).click();
    await expect(draft).toHaveValue("The interviewer noted a clarification about the input.");
    await draft.fill("Clarified what the input represents.");
    await card.getByRole("button", { name: "Save edits" }).click();
    await expect(card.getByRole("button", { name: "Save edits" })).toBeDisabled();
    await page.reload();
    await expect(draft).toHaveValue("Clarified what the input represents.");
    await card.getByRole("button", { name: "Discard draft" }).click();
    await expect(draft).toHaveCount(0);
    await page.reload();
    await expect(card.getByRole("button", { name: "Draft a summary" })).toBeEnabled();
  } finally {
    await close();
  }
});
