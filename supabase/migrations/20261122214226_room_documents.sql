CREATE TABLE "room_documents" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_documents" ADD CONSTRAINT "room_documents_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;