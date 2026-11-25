import { expect, test, type Page } from "@playwright/test";
import { addInterviewQuestion, createInterviewRoom, authorQuestion, openAs, replaceCode, results, signUp, startInterview } from "./helpers";

/*
 * Private interviewer notes (ADR 0016): a Notes tab for the interviewer only, linked to a question
 * and a run, editable and deletable (also after the session ends), shown on the review page — and
 * nothing of it ever reaches the candidate's browser.
 */

const SUM = "a, b = map(int, input().split())\nprint(a + b)";
const SECRET = "SECRET-NOTE: needed a hint about parsing input";
const testsPane = (page: Page) => page.getByRole("region", { name: "Tests" });
const notesList = (page: Page) => testsPane(page).getByRole("list", { name: "Notes" });

test("interviewer notes: private tab, links, edit/delete, after the end, on the review", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  // Everything the candidate's browser receives from the API, to prove no note text ever arrives.
  const candidateBodies: string[] = [];
  cd.on("response", (r) => {
    if (new URL(r.url()).port === "4000") void r.text().then((t) => candidateBodies.push(t), () => {});
  });
  try {
    await test.step("only the interviewer has a Notes tab", async () => {
      await expect(testsPane(iv).getByRole("tab", { name: "Notes" })).toBeVisible();
      await expect(testsPane(cd).getByRole("tab")).toHaveText(["☑ Testcase", ">_ Test Result"]);
    });

    await test.step("a half-written note survives the candidate's Run and switching tabs", async () => {
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      await expect(iv.getByText("No notes yet.")).toBeVisible();
      await iv.getByLabel("New note", { exact: true }).fill(SECRET);

      await replaceCode(cd, SUM);
      await cd.getByRole("button", { name: "Run", exact: true }).click();
      await expect(results(cd).first()).toContainText("Accepted");
      // An incoming run leaves the interviewer's selected tab and note draft intact.
      await expect(testsPane(iv).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
      await expect(iv.getByLabel("New note", { exact: true })).toHaveValue(SECRET);

      await testsPane(iv).getByRole("tab", { name: "Test Result" }).click();
      await expect(results(iv).first()).toContainText("Accepted");
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      await expect(iv.getByLabel("New note", { exact: true })).toHaveValue(SECRET);
    });

    await test.step("the note is about Q1 by default and links the run", async () => {
      await expect(iv.getByLabel("Note is about")).toHaveValue(/[0-9a-f-]{36}/); // the viewed question, not General
      const link = iv.getByLabel("Link a submission");
      const runOption = link.locator("option", { hasText: /^Run \+\d+:\d{2} · Accepted$/ });
      await expect(runOption).toHaveCount(1);
      await link.selectOption({ label: (await runOption.textContent())! });
      await iv.getByRole("button", { name: "Add note" }).click();

      const first = notesList(iv).getByRole("listitem");
      await expect(first).toHaveCount(1);
      await expect(first).toContainText(SECRET);
      await expect(first.locator(".badge")).toHaveText("Q1");
      await expect(first).toContainText(/↳ Run \+\d+:\d{2} · Accepted/);
      await expect(first.locator("time")).toHaveText(/^\+\d+:\d{2}$/);
      await expect(iv.getByLabel("New note", { exact: true })).toHaveValue(""); // cleared after saving
    });

    await test.step("a general note with Cmd/Ctrl+Enter; edit; delete", async () => {
      await iv.getByLabel("Note is about").selectOption("General");
      await expect(iv.getByLabel("Link a submission")).toBeDisabled();
      await iv.getByLabel("New note", { exact: true }).fill("Talked through complexity first");
      await iv.getByLabel("New note", { exact: true }).press("ControlOrMeta+Enter");
      await expect(notesList(iv).getByRole("listitem")).toHaveCount(2);
      const general = notesList(iv).getByRole("listitem").first(); // newest first
      await expect(general.locator(".badge")).toHaveText("General");

      await general.getByRole("button", { name: "Edit" }).click();
      await general.getByLabel("Edit note").fill("Talked through time and space complexity first");
      await general.getByRole("button", { name: "Save" }).click();
      await expect(general.locator(".note-body")).toHaveText("Talked through time and space complexity first");
      await expect(general).toContainText("edited");

      // A scratch note, then delete it (confirmation dialog).
      await iv.getByLabel("New note", { exact: true }).fill("scratch — delete me");
      await iv.getByRole("button", { name: "Add note" }).click();
      await expect(notesList(iv).getByRole("listitem")).toHaveCount(3);
      iv.once("dialog", (d) => d.accept());
      await notesList(iv).getByRole("listitem").filter({ hasText: "scratch — delete me" }).getByRole("button", { name: "Delete" }).click();
      await expect(notesList(iv).getByRole("listitem")).toHaveCount(2);
    });

    await test.step("notes survive a reload (stored on the server, not in the tab)", async () => {
      await iv.reload();
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      await expect(notesList(iv).getByRole("listitem")).toHaveCount(2);
    });

    await test.step("after the session ends: still writable; the review lists them, linked to the run", async () => {
      iv.once("dialog", (d) => d.accept());
      await iv.getByRole("button", { name: "End session" }).click();
      await expect(iv.getByText("This interview has ended.")).toBeVisible();
      await testsPane(iv).getByRole("tab", { name: "Notes" }).click();
      await iv.getByLabel("New note", { exact: true }).fill("Wrap-up: solid on testing");
      await iv.getByRole("button", { name: "Add note" }).click();
      await expect(notesList(iv).getByRole("listitem")).toHaveCount(3);

      await iv.getByRole("link", { name: "Review" }).click();
      const section = iv.getByRole("region", { name: "Notes" });
      const items = section.getByRole("listitem");
      await expect(items).toHaveCount(3);
      // Oldest first on the review.
      await expect(items.nth(0)).toContainText(SECRET);
      await expect(items.nth(1)).toContainText("Talked through time and space complexity first");
      await expect(items.nth(2)).toContainText("Wrap-up: solid on testing");
      const jump = items.nth(0).getByRole("link", { name: /Run \+\d+:\d{2} · Accepted/ });
      const href = await jump.getAttribute("href");
      expect(href).toMatch(/^#submission-[0-9a-f-]{36}$/);
      await expect(iv.locator(href!)).toHaveCount(1); // points at the run in the timeline
      await jump.click();
      await expect(iv.locator(href!)).toBeInViewport();
    });

    await test.step("the candidate never received any of it", async () => {
      await cd.reload();
      await expect(cd.getByText("This interview has ended.")).toBeVisible();
      await expect(testsPane(cd).getByRole("tab", { name: "Notes" })).toHaveCount(0);
      expect(await cd.content()).not.toContain("SECRET-NOTE");
      expect(candidateBodies.length).toBeGreaterThan(0);
      expect(candidateBodies.some((b) => b.includes("SECRET-NOTE") || b.includes("Wrap-up: solid"))).toBe(false);
    });
  } finally {
    await close();
  }
});

/** Hold matching requests until `release()` — a slow network, controlled by the test. */
async function holdRequests(page: Page, method: string, url: RegExp) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.continue();
    await held;
    await route.continue();
  });
  return { release, stop: () => page.unroute(url) };
}

/**
 * Regression (PR #15 review): the fields stay editable while a save is in flight. The response must
 * only clear what was sent — text typed meanwhile is kept, for a new note and for an edit.
 */
test("a slow save never discards text typed while it was saving", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const page = iv.page;
  try {
    await page.goto("/");
    await signUp(page, iv.name);
    await addInterviewQuestion(page);
    await createInterviewRoom(page);
    await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    await testsPane(page).getByRole("tab", { name: "Notes" }).click();
    const composer = page.getByLabel("New note", { exact: true });

    // New note: A is sent; B is typed before the response arrives.
    const post = await holdRequests(page, "POST", /\/rooms\/[^/]+\/notes$/);
    await composer.fill("A: first thought");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByRole("button", { name: "Add note" })).toBeDisabled(); // saving
    await composer.fill("A: first thought — B: and a second one");
    post.release();
    await expect(notesList(page).getByRole("listitem")).toHaveCount(1);
    await expect(notesList(page).getByRole("listitem").first().locator(".note-body")).toHaveText("A: first thought");
    await expect(composer).toHaveValue("A: first thought — B: and a second one"); // not wiped
    await expect(page.getByRole("status").filter({ hasText: "isn't saved yet" })).toBeVisible();
    await post.stop();
    await composer.fill("B on its own");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(notesList(page).getByRole("listitem")).toHaveCount(2);
    await expect(composer).toHaveValue(""); // nothing changed during this save → cleared

    // Edit: A1 is sent; A2 is typed before the response arrives.
    // By position (newest first → A is second): its text leaves the DOM while the edit box is open.
    const note = notesList(page).getByRole("listitem").nth(1);
    await expect(note.locator(".note-body")).toHaveText("A: first thought");
    const patch = await holdRequests(page, "PATCH", /\/rooms\/[^/]+\/notes\/[0-9a-f-]{36}$/);
    await note.getByRole("button", { name: "Edit" }).click();
    await note.getByLabel("Edit note").fill("A1");
    await note.getByRole("button", { name: "Save" }).click();
    await expect(note.getByRole("button", { name: "Save" })).toBeDisabled(); // saving
    await note.getByLabel("Edit note").fill("A2, the better wording");
    patch.release();
    await expect(note.getByRole("status")).toHaveText(/Save again/);
    await expect(note.getByLabel("Edit note")).toHaveValue("A2, the better wording"); // still open, not wiped
    await patch.stop();
    await note.getByRole("button", { name: "Save" }).click();
    await expect(note.locator(".note-body")).toHaveText("A2, the better wording");
    await expect(note.getByLabel("Edit note")).toHaveCount(0); // closed once what's shown was saved
  } finally {
    await iv.close();
  }
});

/**
 * Regression (PR #15 review): a draft started on Q1 stays about Q1 when the interviewer moves to Q2;
 * once it's saved, the next note is about the question being viewed (Q2), with Q2's runs.
 */
test("after saving a draft kept from another question, the next note is about the viewed one", async ({ browser }) => {
  const iv = await openAs(browser, "Iris Interviewer");
  const page = iv.page;
  try {
    await page.goto("/");
    await signUp(page, iv.name);
    await authorQuestion(page, "Multiply two numbers", "# multiply\n", "2 3", "6");
    await page.goto("/");
    const picked = page.getByLabel("Interview questions").getByRole("listitem");
    await addInterviewQuestion(page);
    await addInterviewQuestion(page, "Multiply two numbers");
    await expect(picked).toHaveCount(2);
    await createInterviewRoom(page);
    await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);

    const about = page.getByLabel("Note is about");
    const aboutLabel = () => about.locator("option:checked");
    await testsPane(page).getByRole("tab", { name: "Notes" }).click();
    await expect(aboutLabel()).toHaveText(/^Q1 · /);
    await page.getByLabel("New note", { exact: true }).fill("Q1: started with brute force");

    // Move to Q2 mid-draft: the draft stays about Q1.
    await page.getByRole("navigation", { name: "Questions" }).getByRole("button", { name: /^Q2:/ }).click();
    await expect(aboutLabel()).toHaveText(/^Q1 · /);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(notesList(page).getByRole("listitem").first().locator(".badge")).toHaveText("Q1"); // saved about Q1

    // The next note follows the viewed question.
    await expect(aboutLabel()).toHaveText(/^Q2 · /);
    await page.getByLabel("New note", { exact: true }).fill("Q2: asked about overflow");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(notesList(page).getByRole("listitem")).toHaveCount(2);
    await expect(notesList(page).getByRole("listitem").first().locator(".badge")).toHaveText("Q2");
  } finally {
    await iv.close();
  }
});
