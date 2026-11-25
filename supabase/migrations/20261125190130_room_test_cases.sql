CREATE TABLE "room_test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_question_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"input" text NOT NULL,
	"expected_output" text NOT NULL,
	"is_hidden" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_test_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "room_test_results" (
	"submission_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"is_hidden" boolean NOT NULL,
	"verdict" "verdict" NOT NULL,
	"time_ms" integer NOT NULL,
	"stdout" text,
	"stderr" text,
	CONSTRAINT "room_test_results_submission_id_test_case_id_pk" PRIMARY KEY("submission_id","test_case_id"),
	CONSTRAINT "room_hidden_output_not_stored" CHECK (NOT "room_test_results"."is_hidden" OR ("room_test_results"."stdout" IS NULL AND "room_test_results"."stderr" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "room_test_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_questions" ADD COLUMN "test_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "room_test_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_test_cases" ADD CONSTRAINT "room_test_cases_room_question_id_room_questions_id_fk" FOREIGN KEY ("room_question_id") REFERENCES "public"."room_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_test_results" ADD CONSTRAINT "room_test_results_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_test_results" ADD CONSTRAINT "room_test_results_test_case_id_room_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."room_test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_test_cases_revision" ON "room_test_cases" USING btree ("room_question_id","revision");