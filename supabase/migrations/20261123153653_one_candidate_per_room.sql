ALTER TABLE "room_participants" ADD COLUMN "legacy_extra" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill (hand-written, ADR 0012): rooms that already have several candidates keep them all, but
-- every candidate except the earliest to join is marked legacy so the one-candidate index can be built.
UPDATE "room_participants" p SET "legacy_extra" = true
WHERE p."role" = 'candidate'
  AND EXISTS (
    SELECT 1 FROM "room_participants" e
    WHERE e."room_id" = p."room_id" AND e."role" = 'candidate'
      AND (e."joined_at" < p."joined_at" OR (e."joined_at" = p."joined_at" AND e."user_id" < p."user_id"))
  );--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_one_candidate" ON "room_participants" USING btree ("room_id") WHERE "room_participants"."role" = 'candidate' AND NOT "room_participants"."legacy_extra";--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_one_interviewer" ON "room_participants" USING btree ("room_id") WHERE "room_participants"."role" = 'interviewer';