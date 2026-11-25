import { and, eq, interviewSummaryDrafts } from "@coderoom/db";
import type { EditSummaryDraftRequest, InterviewSummary, InterviewSummaryDraft } from "@coderoom/shared";
import { db } from "../db.js";
import { BadRequest, Conflict, HttpError } from "../errors.js";

type Row = typeof interviewSummaryDrafts.$inferSelect;

const scope = (roomId: string, authorId: string) =>
  and(eq(interviewSummaryDrafts.roomId, roomId), eq(interviewSummaryDrafts.authorId, authorId));

export async function readSummaryDraft(roomId: string, authorId: string) {
  const [row] = await db.select().from(interviewSummaryDrafts).where(scope(roomId, authorId)).limit(1);
  return row;
}

export function summaryDraftView(row: Row | undefined): InterviewSummaryDraft | null {
  return row?.summary ? { ...row.summary, revision: row.revision } : null;
}

const changed = () => new Conflict("The summary draft changed in another tab. Reload the review and try again.");

async function replaceSummary(roomId: string, authorId: string, revision: number, summary: InterviewSummary | null) {
  const [row] = await db.update(interviewSummaryDrafts)
    .set({ summary, revision: revision + 1 })
    .where(and(scope(roomId, authorId), eq(interviewSummaryDrafts.revision, revision)))
    .returning();
  return row;
}

export async function saveGeneratedSummary(roomId: string, authorId: string, previous: Row | undefined, summary: InterviewSummary) {
  if (!summary.items.length) throw new HttpError(422, "The model returned no observations with valid citations.");
  const row = previous
    ? await replaceSummary(roomId, authorId, previous.revision, summary)
    : (await db.insert(interviewSummaryDrafts).values({ roomId, authorId, summary }).onConflictDoNothing().returning())[0];
  const saved = summaryDraftView(row ?? await readSummaryDraft(roomId, authorId));
  if (!saved) throw changed();
  return saved;
}

export async function editSummaryDraft(roomId: string, authorId: string, input: EditSummaryDraftRequest) {
  const current = await readSummaryDraft(roomId, authorId);
  if (!current?.summary || current.revision !== input.revision) throw changed();
  if (input.texts.length !== current.summary.items.length) throw new BadRequest("Include one text value for each draft item.");
  const items = current.summary.items.map((item, i) => ({ ...item, text: input.texts[i]! }));
  const saved = summaryDraftView(await replaceSummary(roomId, authorId, input.revision, { items }));
  if (!saved) throw changed();
  return saved;
}

export async function discardSummaryDraft(roomId: string, authorId: string, revision: number) {
  if (!await replaceSummary(roomId, authorId, revision, null)) throw changed();
}
