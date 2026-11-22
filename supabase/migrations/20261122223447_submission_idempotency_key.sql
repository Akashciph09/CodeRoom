ALTER TABLE "submissions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_user_idempotency_key" ON "submissions" USING btree ("user_id","idempotency_key");