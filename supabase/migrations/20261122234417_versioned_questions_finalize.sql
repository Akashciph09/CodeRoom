ALTER TABLE "rooms" DROP CONSTRAINT "rooms_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_question_id_questions_id_fk";
--> statement-breakpoint
DROP INDEX "test_cases_question_idx";--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "question_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "question_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "prompt";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "question_id";--> statement-breakpoint
ALTER TABLE "submissions" DROP COLUMN "question_id";--> statement-breakpoint
ALTER TABLE "test_cases" DROP COLUMN "question_id";--> statement-breakpoint
DROP TYPE "public"."question_status";