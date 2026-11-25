import { expect, test } from "@playwright/test";
import { authorQuestion, openAs, signUp } from "./helpers";

test("the author selects passing AI suggestions, saves them as hidden, and publishes explicitly", async ({ browser }) => {
  const { page, name, close } = await openAs(browser, "Iris Interviewer");
  try {
    await page.goto("/");
    await signUp(page, name);
    await authorQuestion(page, "Multiply with hidden cases", "# multiply\n", "2 3", "6");
    await page.route("**/test-suggestions", (route) => route.fulfill({ json: {
      suggestions: [
        { input: "0 40", expectedOutput: "0", isHidden: true, verdict: "accepted" },
        { input: "-2 -3", expectedOutput: "6", isHidden: true, verdict: "accepted" },
        { input: "-1 3", expectedOutput: "3", isHidden: true, verdict: "wrong_answer" },
      ],
    } }));
    await page.getByRole("button", { name: "Suggest missing tests" }).click();
    await page.getByLabel("Python reference solution").fill("a, b = map(int, input().split())\nprint(a * b)");
    await page.getByRole("button", { name: "Generate suggestions" }).click();
    const suggestions = page.getByRole("list", { name: "Suggested hidden tests" });
    await expect(suggestions.getByRole("checkbox", { name: "Add suggested test 3" })).toBeDisabled();
    await expect(suggestions.getByText("Reference check: Wrong answer")).toBeVisible();
    const add = page.getByRole("button", { name: "Add selected hidden tests" });
    await expect(add).toBeDisabled();
    await suggestions.getByRole("checkbox", { name: "Add suggested test 1" }).check();
    await add.click();
    await expect(page.getByLabel("Test 2 input")).toHaveValue("0 40");
    await expect(page.getByLabel("Test 2 hidden")).toBeChecked();
    await expect(page.getByLabel("Test 3 input")).toHaveCount(0);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Test 2 input")).toHaveValue("0 40");
    await expect(page.getByLabel("Test 2 hidden")).toBeChecked();
    await page.getByRole("button", { name: "Mark ready" }).click();
    await expect(page.getByText("Marked ready as version 2")).toBeVisible();
  } finally {
    await close();
  }
});
