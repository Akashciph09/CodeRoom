-- Published question versions are immutable, enforced by the database itself.
-- Rooms, submissions and test results point at a published version and its test cases; if either
-- could change afterwards, an old interview's results would no longer match the tests it ran.
-- The API never attempts these writes — these triggers make sure a bug or a manual edit can't either.

CREATE OR REPLACE FUNCTION "public"."forbid_published_version_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'published' THEN
    RAISE EXCEPTION 'question version % is published and immutable', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "question_versions_immutable_when_published"
BEFORE UPDATE OR DELETE ON "public"."question_versions"
FOR EACH ROW EXECUTE FUNCTION "public"."forbid_published_version_change"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."forbid_published_test_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  -- Check both the old and the new parent, so a test can't be moved into or out of a published version.
  FOREACH affected IN ARRAY ARRAY[
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."version_id" END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."version_id" END
  ] LOOP
    IF affected IS NOT NULL AND EXISTS (
      SELECT 1 FROM "public"."question_versions" v WHERE v."id" = affected AND v."status" = 'published'
    ) THEN
      RAISE EXCEPTION 'test cases of published question version % are immutable', affected
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "test_cases_immutable_when_published"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."test_cases"
FOR EACH ROW EXECUTE FUNCTION "public"."forbid_published_test_change"();
