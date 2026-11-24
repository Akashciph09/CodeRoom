-- The unique indexes that composite FKs reference must exist before those FKs (drizzle-kit emits them
-- last), so they come right after the tables.
CREATE TYPE "public"."evaluation_status" AS ENUM('draft', 'submitted');
--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('strong_no_hire', 'no_hire', 'hire', 'strong_hire');
--> statement-breakpoint
CREATE TYPE "public"."rubric_dimension" AS ENUM('problem_solving', 'correctness_testing', 'code_quality', 'communication');
--> statement-breakpoint
CREATE TABLE "evaluation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"dimension" "rubric_dimension" NOT NULL,
	"note_id" uuid,
	"submission_id" uuid,
	"position" integer NOT NULL,
	CONSTRAINT "evaluation_evidence_one_target" CHECK (num_nonnulls("evaluation_evidence"."note_id", "evaluation_evidence"."submission_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "evaluation_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "evaluation_scores" (
	"evaluation_id" uuid NOT NULL,
	"dimension" "rubric_dimension" NOT NULL,
	"rating" integer,
	"not_observed" boolean DEFAULT false NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	CONSTRAINT "evaluation_scores_evaluation_id_dimension_pk" PRIMARY KEY("evaluation_id","dimension"),
	CONSTRAINT "evaluation_scores_rating" CHECK ("evaluation_scores"."rating" BETWEEN 1 AND 4),
	CONSTRAINT "evaluation_scores_rating_or_not_observed" CHECK (NOT ("evaluation_scores"."rating" IS NOT NULL AND "evaluation_scores"."not_observed")),
	CONSTRAINT "evaluation_scores_explanation_length" CHECK (char_length("evaluation_scores"."explanation") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "evaluation_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"evaluator_id" uuid NOT NULL,
	"status" "evaluation_status" DEFAULT 'draft' NOT NULL,
	"recommendation" "recommendation",
	"summary" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluations_submitted_complete" CHECK (("evaluations"."status" = 'draft' AND "evaluations"."submitted_at" IS NULL AND "evaluations"."submitted_by" IS NULL) OR ("evaluations"."status" = 'submitted' AND "evaluations"."submitted_at" IS NOT NULL AND "evaluations"."submitted_by" IS NOT NULL AND "evaluations"."recommendation" IS NOT NULL)),
	CONSTRAINT "evaluations_summary_length" CHECK (char_length("evaluations"."summary") <= 5000)
);
--> statement-breakpoint
ALTER TABLE "evaluations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_evidence_order" ON "evaluation_evidence" USING btree ("evaluation_id","dimension","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_one_per_evaluator" ON "evaluations" USING btree ("room_id","candidate_id","evaluator_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_scope" ON "evaluations" USING btree ("id","room_id","candidate_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "interview_notes_room_scope" ON "interview_notes" USING btree ("id","room_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_candidate_scope" ON "submissions" USING btree ("id","room_id","user_id");
--> statement-breakpoint
ALTER TABLE "evaluation_evidence" ADD CONSTRAINT "evaluation_evidence_score_fk" FOREIGN KEY ("evaluation_id","dimension") REFERENCES "public"."evaluation_scores"("evaluation_id","dimension") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_evidence" ADD CONSTRAINT "evaluation_evidence_scope_fk" FOREIGN KEY ("evaluation_id","room_id","candidate_id") REFERENCES "public"."evaluations"("id","room_id","candidate_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_evidence" ADD CONSTRAINT "evaluation_evidence_note_fk" FOREIGN KEY ("note_id","room_id") REFERENCES "public"."interview_notes"("id","room_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_evidence" ADD CONSTRAINT "evaluation_evidence_submission_fk" FOREIGN KEY ("submission_id","room_id","candidate_id") REFERENCES "public"."submissions"("id","room_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_scores" ADD CONSTRAINT "evaluation_scores_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_candidate_fk" FOREIGN KEY ("room_id","candidate_id") REFERENCES "public"."room_participants"("room_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_evaluator_fk" FOREIGN KEY ("room_id","evaluator_id") REFERENCES "public"."room_participants"("room_id","user_id") ON DELETE cascade ON UPDATE no action;
