import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { Language, Role, SubmissionMode, SubmissionStatus, Verdict } from "@coderoom/shared";

/*
 * Every table has RLS enabled with NO policies: Supabase's public API (anon / authenticated roles)
 * can read nothing. Only the API and worker, connecting as the database owner, touch these tables.
 * Hidden tests and interviewer-only data therefore can't leak through PostgREST even if a key leaks.
 */

export const roleEnum = pgEnum("participant_role", Role.options);
export const languageEnum = pgEnum("language", Language.options);
export const submissionModeEnum = pgEnum("submission_mode", SubmissionMode.options);
export const submissionStatusEnum = pgEnum("submission_status", SubmissionStatus.options);
export const verdictEnum = pgEnum("verdict", Verdict.options);
export const questionVersionStatusEnum = pgEnum("question_version_status", ["draft", "published"]);
export const roomStatusEnum = pgEnum("room_status", ["open", "closed"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * A question's identity and owner. Its content (title, statement, tests…) lives in `question_versions`.
 * `created_by` is the owner — only they can edit it. NULL owner = shared library question (seed data):
 * anyone can run interviews with it, nobody can edit it.
 */
export const questions = pgTable("questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
  /**
   * Optimistic-concurrency counter for the question's whole editing lifecycle: +1 on every draft save,
   * draft creation, publish and discard. It never resets (unlike a per-draft counter, which restarts
   * when a draft is replaced — the ABA problem), so a writer that sends the revision it started from
   * is guaranteed to be acting on exactly the state it saw.
   */
  revision: integer("revision").notNull().default(1),
  ...timestamps,
}).enableRLS();

/**
 * A question's content lives in versions. At most one `draft` per question is editable; publishing
 * gives it the next version number and makes it immutable (enforced by DB triggers, not just the API).
 * Rooms pin a published version, so later edits never change what an interview ran against.
 */
export const questionVersions = pgTable(
  "question_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** 1, 2, 3… assigned on publish; NULL while a draft. */
    version: integer("version"),
    status: questionVersionStatusEnum("status").notNull().default("draft"),
    title: text("title").notNull(),
    statement: text("statement").notNull(),
    constraints: text("constraints").notNull().default(""),
    /** Per-language starter code, e.g. { "python": "...", "javascript": "..." }. */
    starterCode: jsonb("starter_code").$type<Partial<Record<Language, string>>>().notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("question_versions_number").on(t.questionId, t.version),
    // One editable draft per question.
    uniqueIndex("question_versions_one_draft").on(t.questionId).where(sql`${t.status} = 'draft'`),
    check(
      "published_has_number",
      sql`(${t.status} = 'published') = (${t.version} IS NOT NULL AND ${t.publishedAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export const testCases = pgTable(
  "test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    input: text("input").notNull(),
    expectedOutput: text("expected_output").notNull(),
    isHidden: boolean("is_hidden").notNull().default(false),
  },
  (t) => [index("test_cases_version_idx").on(t.versionId, t.position)],
).enableRLS();

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The room's questions (each pinning an exact published version) are in `room_questions`.
  createdBy: uuid("created_by")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  /** Shared with the candidate out-of-band; joining with it grants the candidate role. */
  inviteCode: text("invite_code").notNull().unique(),
  status: roomStatusEnum("status").notNull().default("open"),
  /** When the interviewer ended the session (the interview timer stops here). */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  ...timestamps,
}).enableRLS();

/**
 * The questions of a room, in order (ADR 0009). Each row pins one published version, like rooms used
 * to: fixed at room creation, never changed. `revealed_at` is set when the interviewer reveals it
 * (position 1 at creation); unrevealed questions are never shown to the candidate.
 */
export const roomQuestions = pgTable(
  "room_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** 1-based order in the room. Also the key of the question's Yjs buffer (`code` / `code:<n>`). */
    position: integer("position").notNull(),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "restrict" }),
    /** Weight in the test score (ADR 0011). Relative: the score is normalized over revealed questions. */
    points: integer("points").notNull().default(1),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("room_questions_position").on(t.roomId, t.position),
    // Target of submissions' composite FK: a submission's room + version must match its room question.
    uniqueIndex("room_questions_identity").on(t.id, t.roomId, t.questionVersionId),
    check("room_questions_position_positive", sql`${t.position} >= 1`),
    check("room_questions_points_range", sql`${t.points} BETWEEN 1 AND 100`),
  ],
).enableRLS();

export const roomParticipants = pgTable(
  "room_participants",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * A second candidate from before rooms were limited to one (ADR 0012). Kept so their submissions
     * stay reviewable; ignored by the one-candidate index. Never set for new rows.
     */
    legacyExtra: boolean("legacy_extra").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    // At most one candidate and one interviewer per room — enforced here, so concurrent joins can't race past it.
    uniqueIndex("room_participants_one_candidate").on(t.roomId).where(sql`${t.role} = 'candidate' AND NOT ${t.legacyExtra}`),
    uniqueIndex("room_participants_one_interviewer").on(t.roomId).where(sql`${t.role} = 'interviewer'`),
  ],
).enableRLS();

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** Which of the room's questions this answers (ADR 0009). See the composite FK below. */
    roomQuestionId: uuid("room_question_id").notNull(),
    /** Copied from the room question at submit time; results are graded against this version's tests. */
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    language: languageEnum("language").notNull(),
    mode: submissionModeEnum("mode").notNull(),
    code: text("code").notNull(),
    status: submissionStatusEnum("status").notNull().default("queued"),
    overall: verdictEnum("overall"),
    /**
     * Client-supplied `Idempotency-Key`. Stored in the same row as the submission so the key and the
     * submission are created atomically; the unique constraint makes a retried request find the original.
     */
    idempotencyKey: text("idempotency_key"),
    /**
     * Participant-written cases sent with a Run (ADR 0010), stored so the run is reproducible. Never
     * used for grading: `overall` comes from the question's tests only.
     */
    customCases: jsonb("custom_cases").$type<{ input: string; expectedOutput?: string }[]>(),
    ...timestamps,
  },
  (t) => [
    // NULLs are distinct in a Postgres unique index, so rows without a key never collide.
    uniqueIndex("submissions_user_idempotency_key").on(t.userId, t.idempotencyKey),
    // The submission's room and graded version must be exactly its room question's: a submission can't
    // be recorded against another room's question or a version other than the pinned one.
    foreignKey({
      name: "submissions_room_question_fk",
      columns: [t.roomQuestionId, t.roomId, t.questionVersionId],
      foreignColumns: [roomQuestions.id, roomQuestions.roomId, roomQuestions.questionVersionId],
    }).onDelete("cascade"),
    index("submissions_room_idx").on(t.roomId, t.createdAt),
    // Small partial index for the worker's outbox sweeper ("queued rows older than N seconds").
    index("submissions_queued_idx").on(t.createdAt).where(sql`${t.status} = 'queued'`),
  ],
).enableRLS();

export const testResults = pgTable(
  "test_results",
  {
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    testCaseId: uuid("test_case_id")
      .notNull()
      .references(() => testCases.id, { onDelete: "cascade" }),
    /** Denormalized from test_cases so result views never need a join to decide visibility. */
    isHidden: boolean("is_hidden").notNull(),
    verdict: verdictEnum("verdict").notNull(),
    timeMs: integer("time_ms").notNull(),
    memoryKb: integer("memory_kb"),
    /** Only stored for public tests. */
    stdout: text("stdout"),
    stderr: text("stderr"),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.testCaseId] }),
    check("hidden_output_not_stored", sql`NOT ${t.isHidden} OR (${t.stdout} IS NULL AND ${t.stderr} IS NULL)`),
  ],
).enableRLS();

/** Results of a run's custom cases (ADR 0010). Kept apart from `test_results`, which only holds question tests. */
export const customCaseResults = pgTable(
  "custom_case_results",
  {
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /** Index into `submissions.custom_cases`. */
    position: integer("position").notNull(),
    verdict: verdictEnum("verdict").notNull(),
    timeMs: integer("time_ms").notNull(),
    stdout: text("stdout"),
    stderr: text("stderr"),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.position] })],
).enableRLS();

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * Latest merged Yjs state of a room's shared editor (one row per room).
 * Written by the realtime gateway on a debounce and when the last client leaves.
 */
export const roomDocuments = pgTable("room_documents", {
  roomId: uuid("room_id")
    .primaryKey()
    .references(() => rooms.id, { onDelete: "cascade" }),
  state: bytea("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type Question = typeof questions.$inferSelect;
export type TestCase = typeof testCases.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomParticipant = typeof roomParticipants.$inferSelect;
export type RoomQuestion = typeof roomQuestions.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type TestResultRow = typeof testResults.$inferSelect;
export type NewTestResult = typeof testResults.$inferInsert;
export type CustomCaseResultRow = typeof customCaseResults.$inferSelect;
