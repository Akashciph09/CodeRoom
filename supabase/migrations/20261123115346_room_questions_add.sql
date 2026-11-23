CREATE TABLE "room_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question_version_id" uuid NOT NULL,
	"revealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_questions_position_positive" CHECK ("room_questions"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "room_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "room_question_id" uuid;--> statement-breakpoint
ALTER TABLE "room_questions" ADD CONSTRAINT "room_questions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_questions" ADD CONSTRAINT "room_questions_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_questions_position" ON "room_questions" USING btree ("room_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "room_questions_identity" ON "room_questions" USING btree ("id","room_id","question_version_id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_room_question_id_room_questions_id_fk" FOREIGN KEY ("room_question_id") REFERENCES "public"."room_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Backfill (hand-written, ADR 0009): every existing room becomes a one-question room. Its pinned
-- version becomes position 1, revealed when the room was created; its submissions point at it.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "room_questions" ("room_id", "position", "question_version_id", "revealed_at", "created_at")
SELECT r."id", 1, r."question_version_id", r."created_at", r."created_at"
FROM "rooms" r;--> statement-breakpoint
UPDATE "submissions" s SET "room_question_id" = rq."id"
FROM "room_questions" rq
WHERE rq."room_id" = s."room_id" AND rq."position" = 1;
