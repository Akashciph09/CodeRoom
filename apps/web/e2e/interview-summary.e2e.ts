import { expect, test } from "@playwright/test";
import { addInterviewQuestion, createInterviewRoom, openAs, signUp } from "./helpers";

test("interviewer can draft, follow a citation, edit, and discard a summary", async ({ browser }) => {
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
    await page.getByRole("link", { name: "Review" }).click();
    const source = page.getByRole("region", { name: "Notes" }).getByRole("listitem");
    const anchor = await source.getAttribute("id");
    expect(anchor).toMatch(/^note-/);
    await page.route("**/review/summary", (route) => route.fulfill({ json: {
      items: [{
        section: "went_well",
        text: "The interviewer noted a clarification about the input.",
        citations: [{ anchor, label: "Note 1" }],
      }],
    } }));
    const card = page.getByRole("region", { name: "Interview summary" });
    await card.getByRole("button", { name: "Draft a summary" }).click();
    const draft = card.getByRole("textbox", { name: "What went well, point 1" });
    await expect(draft).toHaveValue("The interviewer noted a clarification about the input.");
    await card.getByRole("link", { name: "Note 1" }).click();
    await expect(source).toBeInViewport();
    expect(new URL(page.url()).hash).toBe(`#${anchor}`);
    await draft.fill("Clarified what the input represents.");
    await expect(draft).toHaveValue("Clarified what the input represents.");
    await card.getByRole("button", { name: "Discard draft" }).click();
    await expect(draft).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Draft a summary" })).toBeEnabled();
  } finally {
    await close();
  }
});
