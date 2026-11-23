import {
  asc,
  customCaseResults,
  eq,
  getTableColumns,
  inArray,
  submissions,
  testCases,
  testResults,
  type CustomCaseResultRow,
  type Submission,
  type TestResultRow,
} from "@coderoom/db";
import type { Role } from "@coderoom/shared";
import { db } from "../db.js";
import { toCandidateView, toInterviewerView } from "../views.js";

export interface SubmissionWithResults {
  submission: Submission;
  results: TestResultRow[];
  /** Results of the run's custom cases (ADR 0010); empty for submits. */
  custom: CustomCaseResultRow[];
}

/** Custom-case results for the given submissions. */
export async function customResultsFor(submissionIds: string[]): Promise<CustomCaseResultRow[]> {
  if (submissionIds.length === 0) return [];
  return db.select().from(customCaseResults).where(inArray(customCaseResults.submissionId, submissionIds));
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
  const [results, custom] = await Promise.all([resultsFor([id]), customResultsFor([id])]);
  return { submission, results, custom };
}

/** The single place that decides which shape of a submission a role may see. */
export function viewFor(role: Role, { submission, results, custom }: SubmissionWithResults) {
  return role === "interviewer"
    ? toInterviewerView(submission, results, custom)
    : toCandidateView(submission, results, custom);
}
