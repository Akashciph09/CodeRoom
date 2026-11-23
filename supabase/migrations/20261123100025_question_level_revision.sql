ALTER TABLE "questions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_versions" DROP COLUMN "revision";