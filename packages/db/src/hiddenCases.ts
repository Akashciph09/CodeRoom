import { and, eq, lte, ne } from "drizzle-orm";
import type { Db } from "./client.js";
import { roomTestCases, roomTestResults, testCases, testResults, type Submission } from "./schema.js";

/** Find a failed hidden result in the attempt’s immutable suite. The caller checks authorization. */
export async function failedHiddenCaseFor(db: Db, submission: Submission, testId: string) {
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
