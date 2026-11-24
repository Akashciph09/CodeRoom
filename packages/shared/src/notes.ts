import { z } from "zod";

/**
 * The interviewer's private notes (ADR 0016). Interviewer-only: never sent to candidates, never in the
 * shared Yjs document or room events.
 */

export const MAX_NOTE_CHARS = 5000;

/** Characters as a person counts them (code points), matching Postgres `char_length`. */
export const noteLength = (s: string) => [...s].length;

export const NoteBody = z
  .string()
  .max(MAX_NOTE_CHARS * 2)
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "Write something first")
      .refine((s) => noteLength(s) <= MAX_NOTE_CHARS, `Notes can be at most ${MAX_NOTE_CHARS} characters`),
  );

/**
 * Create, or replace on edit. Links are optional: a question of this room and/or one of its
 * submissions. When a submission is linked, the note's question is that submission's question.
 */
export const NoteRequest = z
  .object({
    body: NoteBody,
    roomQuestionId: z.string().uuid().nullable().optional(),
    submissionId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type NoteRequest = z.input<typeof NoteRequest>;

export const NoteView = z.object({
  id: z.string().uuid(),
  roomQuestionId: z.string().uuid().nullable(),
  submissionId: z.string().uuid().nullable(),
  body: z.string(),
  authorName: z.string(),
  /** The caller wrote it (only the author can edit or delete). */
  mine: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NoteView = z.infer<typeof NoteView>;
