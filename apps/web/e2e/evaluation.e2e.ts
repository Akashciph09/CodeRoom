import { expect, test, type Locator, type Page } from "@playwright/test";
import { fromApi, replaceCode, selectedSubmission, startInterview } from "./helpers";

/*
 * The interviewer's structured evaluation (ADR 0017): drafted on the review page during the interview,
 * submitted (and locked) only after it ended, with evidence linked to notes and runs — separate from
 * the test score, and never shown to the candidate.
 */

const SUM = "a, b = map(int, input().split())\nprint(a + b)";
const testsPane = (page: Page) => page.getByRole("region", { name: "Tests" });
const card = (page: Page) => page.getByRole("region", { name: /^Evaluation of / });
const dimension = (page: Page, title: string) => card(page).getByRole("group", { name: title, exact: true });
const rate = (page: Page, title: string, level: "1" | "2" | "3" | "4" | "Not observed") =>
  dimension(page, title)
    .getByRole("radio", { name: level === "Not observed" ? /^– Not observed/ : new RegExp(`^${level} `) })
    .check();
const badge = (page: Page) => card(page).locator(".score-head .badge");

async function linkEvidence(group: Locator, label: RegExp) {
  const select = group.getByRole("combobox", { name: /add evidence/ });
  const option = select.locator("option", { hasText: label });
  await expect(option).toHaveCount(1);
  await select.selectOption({ label: (await option.textContent())! });
}

test("draft during the interview, submit after it ends, then locked; separate from the test score; private", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  const candidateBodies: string[] = [];
  cd.on("response", (r) => {
    if (fromApi(r.url())) void r.text().then((t) => candidateBodies.push(t), () => {});
  });
  try {
    await test.step("the candidate submits; the interviewer writes a note", async () => {
      await replaceCode(cd, SUM);
      await cd.getByRole("button", { name: "Submit", exact: true }).click();
      await expect(selectedSubmission(cd)).toContainText("Accepted");
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      await iv.getByLabel("New note", { exact: true }).fill("Clarified the input format before coding");
      await iv.getByRole("button", { name: "Add note" }).click();
      await expect(testsPane(iv).getByRole("list", { name: "Notes" }).getByRole("listitem")).toHaveCount(1);
    });

    let reviewUrl = "";
    await test.step("draft on the review page while the interview is live", async () => {
      await iv.getByRole("link", { name: "Review" }).click();
      reviewUrl = iv.url();
      await expect(badge(iv)).toHaveText("Not started");
      await expect(card(iv).getByRole("button", { name: "Submit evaluation" })).toBeDisabled();
      await expect(card(iv)).toContainText("You can submit once the interview has ended.");
      // Every score shows what it means.
      await expect(dimension(iv, "Problem solving").getByRole("radio")).toHaveCount(5);
      await expect(dimension(iv, "Problem solving")).toContainText("Found a sound approach with little help");

      await rate(iv, "Problem solving", "3");
      await dimension(iv, "Problem solving").getByLabel("Problem solving: explanation").fill("Got to the approach quickly");
      await linkEvidence(dimension(iv, "Problem solving"), /^Note \+\d+:\d{2} · Clarified the input format/);
      await rate(iv, "Correctness and testing", "4");
      await linkEvidence(dimension(iv, "Correctness and testing"), /^Q1 · Submit \+\d+:\d{2} · Accepted$/);
      await rate(iv, "Code quality", "Not observed");
      await expect(badge(iv)).toHaveText("Not saved yet");
      await card(iv).getByRole("button", { name: "Save draft" }).click();
      await expect(badge(iv)).toHaveText("Draft · saved");
    });

    await test.step("the draft is kept on the server (reload)", async () => {
      await iv.reload();
      await expect(badge(iv)).toHaveText("Draft · saved");
      await expect(dimension(iv, "Problem solving").getByRole("radio", { name: /^3/ })).toBeChecked();
      await expect(dimension(iv, "Code quality").getByRole("radio", { name: /^–/ })).toBeChecked();
      await expect(dimension(iv, "Problem solving").getByLabel("Problem solving: explanation")).toHaveValue("Got to the approach quickly");
      const chip = dimension(iv, "Correctness and testing").getByRole("list", { name: "Correctness and testing: evidence" }).getByRole("link");
      await expect(chip).toHaveText(/^Q1 · Submit \+\d+:\d{2} · Accepted$/);
      expect(await chip.getAttribute("href")).toMatch(/^#submission-[0-9a-f-]{36}$/);
    });

    await test.step("after the interview ends: what's missing is listed; then submit locks it", async () => {
      await iv.getByRole("link", { name: "← Back to the room" }).click();
      iv.once("dialog", (d) => d.accept());
      await iv.getByRole("button", { name: "End session" }).click();
      await expect(iv.getByText("This interview has ended.")).toBeVisible();
      await iv.goto(reviewUrl);
      const missing = card(iv).getByRole("group", { name: "Before you can submit" });
      await expect(missing).toContainText("Score “Communication”");
      await expect(missing).toContainText("Choose an overall recommendation.");
      await expect(card(iv).getByRole("button", { name: "Submit evaluation" })).toBeDisabled();

      await rate(iv, "Communication", "3");
      await card(iv).getByRole("group", { name: "Overall recommendation" }).getByRole("radio", { name: "Hire", exact: true }).check();
      await expect(missing).toHaveCount(0);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const submitRoute = /\/rooms\/[^/]+\/evaluations\/[^/]+\/submit$/;
      await iv.route(submitRoute, async (route) => {
        await held;
        await route.continue();
      });
      try {
        const pending = iv.waitForRequest((request) => request.method() === "POST" && submitRoute.test(request.url()));
        iv.once("dialog", (d) => d.accept());
        await card(iv).getByRole("button", { name: "Submit evaluation" }).click();
        await pending; // The draft save has completed and the final submit is in flight.
        await expect(card(iv).getByLabel("Evaluation summary")).toBeDisabled();
        await expect(dimension(iv, "Problem solving").getByRole("radio", { name: /^3/ })).toBeDisabled();
      } finally {
        release();
      }

      await expect(badge(iv)).toHaveText("Submitted");
      await expect(card(iv)).toContainText("Submitted by Iris Interviewer");
      await expect(card(iv).getByRole("radio")).toHaveCount(0); // read-only
      await expect(card(iv).getByRole("button", { name: /Save draft|Submit evaluation/ })).toHaveCount(0);
      await expect(card(iv).getByRole("group", { name: "Problem solving" })).toHaveCount(0);
      const rows = card(iv).locator(".rubric-result-row");
      await expect(rows.filter({ hasText: "Problem solving" })).toContainText("3 / 4");
      await expect(rows.filter({ hasText: "Code quality" })).toContainText("Not observed");
      await expect(rows.filter({ hasText: "Overall recommendation" })).toContainText("Hire");
      await expect(rows.filter({ hasText: "Problem solving" }).getByRole("link")).toHaveAttribute("href", /^#note-[0-9a-f-]{36}$/);
    });

    await test.step("still locked after a reload; the test score is its own, unchanged section", async () => {
      await iv.reload();
      await expect(badge(iv)).toHaveText("Submitted");
      await expect(iv.getByRole("region", { name: /^Candidate / }).getByLabel("Test score")).toContainText("100");
      await expect(iv.getByRole("region", { name: /^Candidate / })).not.toContainText("Hire");
    });

    await test.step("a note cited by the submitted evaluation can't be edited any more", async () => {
      await iv.getByRole("link", { name: "← Back to the room" }).click();
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      const note = testsPane(iv).getByRole("list", { name: "Notes" }).getByRole("listitem").first();
      await note.getByRole("button", { name: "Edit" }).click();
      await note.getByLabel("Edit note").fill("rewritten");
      await note.getByRole("button", { name: "Save" }).click();
      await expect(note.getByRole("alert")).toContainText("evidence in a submitted evaluation");
    });

    await test.step("the candidate never receives any of it", async () => {
      await cd.goto(reviewUrl);
      await expect(cd.getByText("Only the interviewer can review this interview.")).toBeVisible();
      expect(candidateBodies.length).toBeGreaterThan(0);
      expect(candidateBodies.some((b) => /Got to the approach quickly|recommendation|"evaluation"/.test(b))).toBe(false);
    });
  } finally {
    await close();
  }
});

/** Edits made while a draft save is in flight are kept, not replaced by the response. */
test("a slow draft save keeps what was typed meanwhile", async ({ browser }) => {
  const { interviewer, close } = await startInterview(browser);
  const iv = interviewer.page;
  try {
    await iv.getByRole("link", { name: "Review" }).click();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await iv.route(/\/rooms\/[^/]+\/evaluations\/[^/]+$/, async (route) => {
      await held;
      await route.continue();
    });
    await rate(iv, "Problem solving", "2");
    const why = dimension(iv, "Problem solving").getByLabel("Problem solving: explanation");
    await why.fill("first");
    await card(iv).getByRole("button", { name: "Save draft" }).click();
    await expect(card(iv).getByRole("button", { name: "Save draft" })).toBeDisabled(); // saving
    await why.fill("first, then more");
    release();
    await expect(badge(iv)).toHaveText("Draft · unsaved changes"); // saved, but not what's on screen now
    await expect(why).toHaveValue("first, then more");
    await iv.unroute(/\/rooms\/[^/]+\/evaluations\/[^/]+$/);
    await card(iv).getByRole("button", { name: "Save draft" }).click();
    await expect(badge(iv)).toHaveText("Draft · saved");
    await iv.reload();
    await expect(dimension(iv, "Problem solving").getByLabel("Problem solving: explanation")).toHaveValue("first, then more");
  } finally {
    await close();
  }
});
