CREATE TYPE "public"."language" AS ENUM('javascript', 'python');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('interviewer', 'candidate');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."submission_mode" AS ENUM('run', 'submit');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'compile_error', 'internal_error');--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"status" "question_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "room_participants" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "participant_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_participants_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"invite_code" text NOT NULL,
	"status" "room_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"language" "language" NOT NULL,
	"mode" "submission_mode" NOT NULL,
	"code" text NOT NULL,
	"status" "submission_status" DEFAULT 'queued' NOT NULL,
	"overall" "verdict",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"input" text NOT NULL,
	"expected_output" text NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_results" (
	"submission_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"is_hidden" boolean NOT NULL,
	"verdict" "verdict" NOT NULL,
	"time_ms" integer NOT NULL,
	"memory_kb" integer,
	"stdout" text,
	"stderr" text,
	CONSTRAINT "test_results_submission_id_test_case_id_pk" PRIMARY KEY("submission_id","test_case_id"),
	CONSTRAINT "hidden_output_not_stored" CHECK (NOT "test_results"."is_hidden" OR ("test_results"."stdout" IS NULL AND "test_results"."stderr" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "test_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submissions_room_idx" ON "submissions" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "test_cases_question_idx" ON "test_cases" USING btree ("question_id","position");