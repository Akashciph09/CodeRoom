ALTER TABLE "rooms" DROP CONSTRAINT "rooms_question_version_id_question_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_room_question_id_room_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "room_question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_room_question_fk" FOREIGN KEY ("room_question_id","room_id","question_version_id") REFERENCES "public"."room_questions"("id","room_id","question_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "question_version_id";