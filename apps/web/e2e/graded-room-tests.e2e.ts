import { expect, test } from "@playwright/test";
import { replaceCode, results, startInterview } from "./helpers";

test("reviewed room tests update candidate grading without exposing hidden inputs or changing prior results", async ({ browser }) => {
  const { interviewer, candidate, close } = await startInterview(browser);
  const iv = interviewer.page;
  const cd = candidate.page;
  const candidateTests = cd.getByRole("region", { name: "Tests" });
  const interviewerTests = iv.getByRole("group", { name: "Graded room tests" });
  const notice = cd.getByText("The interviewer added additional tests. Please resubmit.");
  const hiddenInput = "314159 -271828";
  try {
    await expect(candidateTests.getByRole("button", { name: "Add a custom test case" })).toBeVisible();
    await expect(cd.getByRole("button", { name: "Suggest test cases" })).toHaveCount(0);
    await replaceCode(cd, "a, b = map(int, input().split())\nprint(a+b)");
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(results(cd).first()).toContainText("hidden tests 2/2");

    await iv.getByRole("tab", { name: "Testcase" }).click();
    await interviewerTests.getByRole("button", { name: "Add test case", exact: true }).click();
    await interviewerTests.getByLabel("Room test input").fill(hiddenInput);
    await interviewerTests.getByLabel("Room test expected output").fill("42331");
    const hidden = interviewerTests.getByRole("button", { name: "Add as hidden" });
    await expect(hidden).toBeDisabled();
    await interviewerTests.getByRole("checkbox", { name: "I confirm the expected output is correct." }).check();
    await hidden.click();
    await expect(notice).toBeVisible();
    await expect(cd.getByText(hiddenInput, { exact: true })).toHaveCount(0);

    await iv.route("**/tests/suggest", (route) => route.fulfill({ json: {
      tests: [
        { input: "-101 101", expectedOutput: "1", reason: "Opposite signs catch incorrect cancellation." },
        { input: "0 0", expectedOutput: "0", reason: "Two zeros catch treating zero as missing." },
        { input: "-10 -20", expectedOutput: "-30", reason: "Negative values catch clamping to zero." },
      ],
    } }));
    await interviewerTests.getByRole("button", { name: "Suggest test cases" }).click();
    const suggestions = interviewerTests.getByRole("list", { name: "Suggested room tests" });
    await expect(suggestions.getByRole("listitem")).toHaveCount(3);
    await expect(suggestions.getByText("Opposite signs catch incorrect cancellation.")).toBeVisible();
    await suggestions.getByRole("button", { name: "Review suggestion 1" }).click();
    await interviewerTests.getByLabel("Room test expected output").fill("0");
    await interviewerTests.getByRole("checkbox", { name: "I confirm the expected output is correct." }).check();
    await interviewerTests.getByRole("button", { name: "Add as public" }).click();

    await candidateTests.getByRole("tab", { name: "Testcase" }).click();
    await candidateTests.getByRole("button", { name: "Case 3", exact: true }).click();
    await expect(candidateTests.getByLabel("Case input")).toHaveText("-101 101");
    await expect(candidateTests.getByLabel("Case expected output")).toHaveText("0");
    await cd.getByRole("button", { name: "Run", exact: true }).click();
    await expect(results(cd)).toHaveCount(2);
    await expect(results(cd).first()).toContainText("Example 3");
    await expect(notice).toBeVisible();
    await cd.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(results(cd)).toHaveCount(3);
    await expect(results(cd).first()).toContainText("hidden tests 3/3");
    await expect(results(cd).last()).toContainText("hidden tests 2/2");
    await expect(notice).toHaveCount(0);
  } finally {
    await close();
  }
});
