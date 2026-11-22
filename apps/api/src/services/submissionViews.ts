import { asc, eq, submissions, testResults, type Submission, type TestResultRow } from "@coderoom/db";
import type { Role } from "@coderoom/shared";
import { db } from "../db.js";
import { toCandidateView, toInterviewerView } from "../views.js";

export interface SubmissionWithResults {
  submission: Submission;
  results: TestResultRow[];
}

export async function loadSubmissionWithResults(id: string): Promise<SubmissionWithResults | null> {
  const [submission] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  if (!submission) return null;
  const results = await db
    .select()
    .from(testResults)
    .where(eq(testResults.submissionId, id))
    .orderBy(asc(testResults.testCaseId));
  return { submission, results };
}

/** The single place that decides which shape of a submission a role may see. */
export function viewFor(role: Role, { submission, results }: SubmissionWithResults) {
  return role === "interviewer" ? toInterviewerView(submission, results) : toCandidateView(submission, results);
}
