-- A deleted submission (e.g. the candidate's account was deleted: auth.users → submissions cascades)
-- must not be blocked by a note that links it, and must not delete the note: the note belongs to the
-- interviewer and its room still exists. Clear only the link. The column list keeps room_id (NOT NULL,
-- the note's room scope) — a plain SET NULL would null both FK columns. Needs Postgres 15+.
-- drizzle-kit can't express the column list, so this is a hand-written migration (see schema.ts).
ALTER TABLE "interview_notes" DROP CONSTRAINT "interview_notes_submission_fk";
--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_submission_fk" FOREIGN KEY ("submission_id","room_id") REFERENCES "public"."submissions"("id","room_id") ON DELETE SET NULL ("submission_id") ON UPDATE no action;
