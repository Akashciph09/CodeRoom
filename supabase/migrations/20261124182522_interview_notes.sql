-- The (id, room_id) unique indexes must exist before the composite FKs that reference them
-- (drizzle-kit emits them last), so they come first.
CREATE UNIQUE INDEX "room_questions_room_scope" ON "room_questions" USING btree ("id","room_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_room_scope" ON "submissions" USING btree ("id","room_id");
--> statement-breakpoint
CREATE TABLE "interview_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"room_question_id" uuid,
	"submission_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_notes_body_length" CHECK (char_length(btrim("interview_notes"."body")) BETWEEN 1 AND 5000)
);
--> statement-breakpoint
ALTER TABLE "interview_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_question_fk" FOREIGN KEY ("room_question_id","room_id") REFERENCES "public"."room_questions"("id","room_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_submission_fk" FOREIGN KEY ("submission_id","room_id") REFERENCES "public"."submissions"("id","room_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "interview_notes_room_idx" ON "interview_notes" USING btree ("room_id","created_at");
