import { expect, test } from "@playwright/test";
import { replaceCode, results, startInterview } from "./helpers";

/** The interviewer's room list shows who interviewed and how they scored, with search (ADR 0013). */
test("the interviewer's room list shows the candidate, their email and score, and can be searched", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  try {
    await replaceCode(cd, "a, b = map(int, input().split())\nprint(a + b)");
    await cd.getByRole("button", { name: "Submit" }).click();
    await expect(results(cd).first()).toContainText("Accepted", { timeout: 30_000 });
    const roomPath = new URL(iv.url()).pathname;

    // A second room that nobody joins.
    await iv.goto("/");
    await iv.getByRole("button", { name: "Create room" }).click();
    await expect(iv).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    await iv.goto("/");

    const list = iv.getByRole("list", { name: "Your rooms" });
    const row = list.getByRole("listitem").filter({ has: iv.locator(`a[href="${roomPath}"]`) });
    await expect(row).toContainText("Casey Candidate");
    await expect(row).toContainText(/@example\.test/);
    await expect(row.getByLabel("Test score")).toHaveText("Score 100/100");
    await expect(row.getByRole("link", { name: "Review" })).toHaveAttribute("href", `${roomPath}/review`);
    await expect(list.getByRole("listitem").filter({ hasText: "No candidate joined" })).toHaveCount(1);

    // Search by candidate email, name and question.
    const email = (await row.locator(".room-candidate .muted").textContent())!.replace("·", "").trim();
    const search = iv.getByLabel("Search rooms");
    await search.fill(email);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByRole("listitem")).toContainText("Casey Candidate");
    await search.fill("casey");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await search.fill("sum two");
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await search.fill("nobody-like-this");
    await expect(iv.getByText("No rooms match “nobody-like-this”.")).toBeVisible();

    // The candidate's own list shows the room, but nothing about candidates or scores.
    await cd.goto("/");
    const cdList = cd.getByRole("list", { name: "Your rooms" });
    await expect(cdList.locator(`a[href="${roomPath}"]`)).toBeVisible();
    await expect(cdList).not.toContainText("@example.test");
    await expect(cdList).not.toContainText("Score");
    await expect(cdList.getByRole("link", { name: "Review" })).toHaveCount(0);
  } finally {
    await close();
  }
});
