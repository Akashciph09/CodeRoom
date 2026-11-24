-- Submitted evaluations are locked, enforced by the database itself (ADR 0017). The API checks the
-- same rules first and answers with clear errors; these triggers make sure a bug or a manual edit
-- can't get around them.
--
-- Deletes that CASCADE from removing a room or an account still go through: they run inside the
-- foreign key's own trigger, so pg_trigger_depth() > 1. Only direct changes are refused.

CREATE OR REPLACE FUNCTION "public"."evaluation_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN
      RAISE EXCEPTION 'an evaluation starts as a draft' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'submitted' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'evaluation % is submitted and locked', OLD."id" USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'submitted' THEN
    RAISE EXCEPTION 'evaluation % is submitted and locked', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'submitted' THEN
    -- Submitting: only after the interview ended, and only when complete — every dimension scored
    -- 1–4 or "not observed", and at least one actually scored. (The recommendation is a CHECK.)
    IF NOT EXISTS (SELECT 1 FROM "public"."rooms" r WHERE r."id" = NEW."room_id" AND r."status" = 'closed') THEN
      RAISE EXCEPTION 'evaluation % can only be submitted after the interview ended', NEW."id" USING ERRCODE = 'restrict_violation';
    END IF;
    IF (SELECT count(*) FROM "public"."evaluation_scores" s
          WHERE s."evaluation_id" = NEW."id" AND (s."rating" IS NOT NULL OR s."not_observed"))
         <> (SELECT count(*) FROM unnest(enum_range(NULL::"public"."rubric_dimension")))
       OR NOT EXISTS (SELECT 1 FROM "public"."evaluation_scores" s WHERE s."evaluation_id" = NEW."id" AND s."rating" IS NOT NULL) THEN
      RAISE EXCEPTION 'evaluation % is incomplete', NEW."id" USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evaluations_locked_when_submitted"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."evaluations"
FOR EACH ROW EXECUTE FUNCTION "public"."evaluation_lock"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."evaluation_part_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD; -- cascading from a deleted room, account, note or run
  END IF;
  -- Check the old and the new parent, so a row can't be moved into or out of a submitted evaluation.
  FOREACH affected IN ARRAY ARRAY[
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."evaluation_id" END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."evaluation_id" END
  ] LOOP
    IF affected IS NOT NULL AND EXISTS (
      SELECT 1 FROM "public"."evaluations" v WHERE v."id" = affected AND v."status" = 'submitted'
    ) THEN
      RAISE EXCEPTION 'evaluation % is submitted and locked', affected USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evaluation_scores_locked_when_submitted"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."evaluation_scores"
FOR EACH ROW EXECUTE FUNCTION "public"."evaluation_part_lock"();
--> statement-breakpoint
CREATE TRIGGER "evaluation_evidence_locked_when_submitted"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."evaluation_evidence"
FOR EACH ROW EXECUTE FUNCTION "public"."evaluation_part_lock"();
--> statement-breakpoint

-- A note cited by a submitted evaluation is part of that evaluation's evidence: it can't be edited
-- or deleted any more (cascades from deleting the room or an account still apply).
CREATE OR REPLACE FUNCTION "public"."cited_note_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND EXISTS (
    SELECT 1 FROM "public"."evaluation_evidence" e
    JOIN "public"."evaluations" v ON v."id" = e."evaluation_id"
    WHERE e."note_id" = OLD."id" AND v."status" = 'submitted'
  ) THEN
    RAISE EXCEPTION 'note % is cited by a submitted evaluation', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "interview_notes_locked_when_cited"
BEFORE UPDATE OR DELETE ON "public"."interview_notes"
FOR EACH ROW EXECUTE FUNCTION "public"."cited_note_lock"();
