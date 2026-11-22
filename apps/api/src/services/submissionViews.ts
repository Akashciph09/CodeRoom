import { asc, eq, getTableColumns, inArray, submissions, testCases, testResults, type Submission, type TestResultRow } from "@coderoom/db";
import type { Role } from "@coderoom/shared";
import { db } from "../db.js";
import { toCandidateView, toInterviewerView } from "../views.js";

export interface SubmissionWithResults {
  submission: Submission;
  results: TestResultRow[];
}

/** Test results for the given submissions, in the question's test order (test_cases.position). */
export async function resultsFor(submissionIds: string[]): Promise<TestResultRow[]> {
  if (submissionIds.length === 0) return [];
  return db
    .select(getTableColumns(testResults))
    .from(testResults)
    .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
    .where(inArray(testResults.submissionId, submissionIds))
    .orderBy(asc(testCases.position));
}

export async function loadSubmissionWithResults(id: string): Promise<SubmissionWithResults | null> {
  const [submission] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  if (!submission) return null;
  return { submission, results: await resultsFor([id]) };
}

/** The single place that decides which shape of a submission a role may see. */
export function viewFor(role: Role, { submission, results }: SubmissionWithResults) {
  return role === "interviewer" ? toInterviewerView(submission, results) : toCandidateView(submission, results);
}
