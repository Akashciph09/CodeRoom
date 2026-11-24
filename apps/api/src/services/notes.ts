import { and, asc, eq, interviewNotes, roomQuestions, sql, submissions } from "@coderoom/db";
import type { NoteView } from "@coderoom/shared";
import { db } from "../db.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";

/*
 * Private interviewer notes (ADR 0016). Callers must have checked the interviewer role; these
 * functions scope every query to the room, so a note id from another room is "not found".
 */

type Links = { roomQuestionId?: string | null; submissionId?: string | null };

/**
 * Validate the optional links against the room. A linked submission decides the question (a
 * mismatching question is refused). The composite foreign keys enforce the same room scope in the DB.
 */
async function resolveLinks(roomId: string, links: Links): Promise<{ roomQuestionId: string | null; submissionId: string | null }> {
  const submissionId = links.submissionId ?? null;
  let roomQuestionId = links.roomQuestionId ?? null;
  if (submissionId) {
    const [s] = await db
      .select({ roomQuestionId: submissions.roomQuestionId })
      .from(submissions)
      .where(and(eq(submissions.id, submissionId), eq(submissions.roomId, roomId)))
      .limit(1);
    if (!s) throw new NotFound("Submission not found in this room");
    if (roomQuestionId && roomQuestionId !== s.roomQuestionId) {
      throw new BadRequest("That submission belongs to a different question");
    }
    roomQuestionId = s.roomQuestionId;
  } else if (roomQuestionId) {
    const [q] = await db
      .select({ id: roomQuestions.id })
      .from(roomQuestions)
      .where(and(eq(roomQuestions.id, roomQuestionId), eq(roomQuestions.roomId, roomId)))
      .limit(1);
    if (!q) throw new NotFound("Question not found in this room");
  }
  return { roomQuestionId, submissionId };
}

/** The room's notes, oldest first, with each author's display name. */
export async function listNotes(roomId: string, viewerId: string): Promise<NoteView[]> {
  const rows = await db
    .select({
      id: interviewNotes.id,
      authorId: interviewNotes.authorId,
      roomQuestionId: interviewNotes.roomQuestionId,
      submissionId: interviewNotes.submissionId,
      body: interviewNotes.body,
      createdAt: interviewNotes.createdAt,
      updatedAt: interviewNotes.updatedAt,
      authorName: sql<string>`coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(u.email, '@', 1), 'Interviewer')`,
    })
    .from(interviewNotes)
    .innerJoin(sql`auth.users u`, sql`u.id = ${interviewNotes.authorId}`)
    .where(eq(interviewNotes.roomId, roomId))
    .orderBy(asc(interviewNotes.createdAt), asc(interviewNotes.id));
  return rows.map(({ authorId, createdAt, updatedAt, ...n }) => ({
    ...n,
    mine: authorId === viewerId,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  }));
}

async function noteView(roomId: string, viewerId: string, noteId: string): Promise<NoteView> {
  const note = (await listNotes(roomId, viewerId)).find((n) => n.id === noteId);
  if (!note) throw new NotFound("Note not found");
  return note;
}

export async function createNote(roomId: string, authorId: string, body: string, links: Links): Promise<NoteView> {
  const resolved = await resolveLinks(roomId, links);
  const [row] = await db
    .insert(interviewNotes)
    .values({ roomId, authorId, body, ...resolved })
    .returning({ id: interviewNotes.id });
  return noteView(roomId, authorId, row!.id);
}

/** Only the author may change a note; a note of another room is "not found". */
async function requireAuthor(roomId: string, userId: string, noteId: string) {
  const [note] = await db
    .select({ authorId: interviewNotes.authorId })
    .from(interviewNotes)
    .where(and(eq(interviewNotes.id, noteId), eq(interviewNotes.roomId, roomId)))
    .limit(1);
  if (!note) throw new NotFound("Note not found");
  if (note.authorId !== userId) throw new Forbidden("Only the note's author can change it");
}

/** Replace the text and links; `updated_at` records the edit. */
export async function updateNote(roomId: string, userId: string, noteId: string, body: string, links: Links): Promise<NoteView> {
  await requireAuthor(roomId, userId, noteId);
  const resolved = await resolveLinks(roomId, links);
  await db
    .update(interviewNotes)
    .set({ body, ...resolved, updatedAt: sql`now()` })
    .where(and(eq(interviewNotes.id, noteId), eq(interviewNotes.roomId, roomId), eq(interviewNotes.authorId, userId)));
  return noteView(roomId, userId, noteId);
}

export async function deleteNote(roomId: string, userId: string, noteId: string): Promise<void> {
  await requireAuthor(roomId, userId, noteId);
  await db
    .delete(interviewNotes)
    .where(and(eq(interviewNotes.id, noteId), eq(interviewNotes.roomId, roomId), eq(interviewNotes.authorId, userId)));
}
