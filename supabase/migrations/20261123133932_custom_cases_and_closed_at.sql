CREATE TABLE "custom_case_results" (
	"submission_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"verdict" "verdict" NOT NULL,
	"time_ms" integer NOT NULL,
	"stdout" text,
	"stderr" text,
	CONSTRAINT "custom_case_results_submission_id_position_pk" PRIMARY KEY("submission_id","position")
);
--> statement-breakpoint
ALTER TABLE "custom_case_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "custom_cases" jsonb;--> statement-breakpoint
ALTER TABLE "custom_case_results" ADD CONSTRAINT "custom_case_results_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill (hand-written, ADR 0010): rooms that already ended stop their timer at their last update.
UPDATE "rooms" SET "closed_at" = "updated_at" WHERE "status" = 'closed' AND "closed_at" IS NULL;
