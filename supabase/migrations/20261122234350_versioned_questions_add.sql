CREATE TYPE "public"."question_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer,
	"status" "question_version_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"constraints" text DEFAULT '' NOT NULL,
	"starter_code" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_has_number" CHECK (("question_versions"."status" = 'published') = ("question_versions"."version" IS NOT NULL AND "question_versions"."published_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "question_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "question_version_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "question_version_id" uuid;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_number" ON "question_versions" USING btree ("question_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_one_draft" ON "question_versions" USING btree ("question_id") WHERE "question_versions"."status" = 'draft';--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_version_id_question_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."question_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_cases_version_idx" ON "test_cases" USING btree ("version_id","position");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Backfill (hand-written): every existing question becomes version 1 of itself, and existing
-- test cases, rooms and submissions are pointed at that version. Approved questions are published.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "question_versions" ("question_id", "version", "status", "title", "statement", "published_at", "created_at", "updated_at")
SELECT q."id",
       CASE WHEN q."status" = 'approved' THEN 1 END,
       CASE WHEN q."status" = 'approved' THEN 'published' ELSE 'draft' END::"question_version_status",
       q."title", q."prompt",
       CASE WHEN q."status" = 'approved' THEN q."updated_at" END,
       q."created_at", q."updated_at"
FROM "questions" q;--> statement-breakpoint
UPDATE "test_cases" t SET "version_id" = v."id"
FROM "question_versions" v WHERE v."question_id" = t."question_id";--> statement-breakpoint
UPDATE "rooms" r SET "question_version_id" = v."id"
FROM "question_versions" v WHERE v."question_id" = r."question_id";--> statement-breakpoint
UPDATE "submissions" s SET "question_version_id" = v."id"
FROM "question_versions" v WHERE v."question_id" = s."question_id";
