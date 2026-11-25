import {
  and,
  asc,
  customCaseResults,
  eq,
  getTableColumns,
  inArray,
  lte,
  ne,
  submissions,
  roomTestCases,
  roomTestResults,
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
  const [bank, room] = await Promise.all([
    db.select(getTableColumns(testResults))
      .from(testResults)
      .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
      .where(inArray(testResults.submissionId, submissionIds))
      .orderBy(asc(testCases.position)),
    db.select(getTableColumns(roomTestResults))
      .from(roomTestResults)
      .innerJoin(roomTestCases, eq(roomTestCases.id, roomTestResults.testCaseId))
      .where(inArray(roomTestResults.submissionId, submissionIds))
      .orderBy(asc(roomTestCases.revision)),
  ]);
  return [...bank, ...room.map((row) => ({ ...row, memoryKb: null }))];
}

export async function loadSubmissionWithResults(id: string): Promise<SubmissionWithResults | null> {
  const [submission] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  if (!submission) return null;
  const [results, custom] = await Promise.all([resultsFor([id]), customResultsFor([id])]);
  return { submission, results, custom };
}

/** An already-authorized interviewer can inspect a failed result from this attempt's pinned suite. */
export async function failedHiddenCaseFor(submission: Submission, testId: string) {
  const [bank, room] = await Promise.all([
    db.select({ input: testCases.input, expectedOutput: testCases.expectedOutput })
      .from(testResults).innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
      .where(and(eq(testResults.submissionId, submission.id), eq(testResults.testCaseId, testId),
        eq(testResults.isHidden, true), ne(testResults.verdict, "accepted"), eq(testCases.isHidden, true),
        eq(testCases.versionId, submission.questionVersionId))),
    db.select({ input: roomTestCases.input, expectedOutput: roomTestCases.expectedOutput })
      .from(roomTestResults).innerJoin(roomTestCases, eq(roomTestCases.id, roomTestResults.testCaseId))
      .where(and(eq(roomTestResults.submissionId, submission.id), eq(roomTestResults.testCaseId, testId),
        eq(roomTestResults.isHidden, true), ne(roomTestResults.verdict, "accepted"), eq(roomTestCases.isHidden, true),
        eq(roomTestCases.roomQuestionId, submission.roomQuestionId), lte(roomTestCases.revision, submission.roomTestRevision))),
  ]);
  return bank[0] ?? room[0];
}

/** The single place that decides which shape of a submission a role may see. */
export function viewFor(role: Role, { submission, results, custom }: SubmissionWithResults) {
  return role === "interviewer"
    ? toInterviewerView(submission, results, custom)
    : toCandidateView(submission, results, custom);
}
