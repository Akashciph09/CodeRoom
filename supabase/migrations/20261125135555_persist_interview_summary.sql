CREATE TABLE "interview_summary_drafts" (
	"room_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"summary" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "interview_summary_drafts_room_id_author_id_pk" PRIMARY KEY("room_id","author_id")
);
--> statement-breakpoint
ALTER TABLE "interview_summary_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_summary_drafts" ADD CONSTRAINT "interview_summary_drafts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_summary_drafts" ADD CONSTRAINT "interview_summary_drafts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;