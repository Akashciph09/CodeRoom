import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
export const questionStatusEnum = pgEnum("question_status", ["draft", "approved"]);
export const roomStatusEnum = pgEnum("room_status", ["open", "closed"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const questions = pgTable("questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  /** AI-generated questions start as drafts; only approved questions can be used in rooms. */
  status: questionStatusEnum("status").notNull().default("draft"),
  createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
  ...timestamps,
}).enableRLS();

export const testCases = pgTable(
  "test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    input: text("input").notNull(),
    expectedOutput: text("expected_output").notNull(),
    isHidden: boolean("is_hidden").notNull().default(false),
  },
  (t) => [index("test_cases_question_idx").on(t.questionId, t.position)],
).enableRLS();

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id")
    .notNull()
    .references(() => questions.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  /** Shared with the candidate out-of-band; joining with it grants the candidate role. */
  inviteCode: text("invite_code").notNull().unique(),
  status: roomStatusEnum("status").notNull().default("open"),
  ...timestamps,
}).enableRLS();

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
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
).enableRLS();

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    language: languageEnum("language").notNull(),
    mode: submissionModeEnum("mode").notNull(),
    code: text("code").notNull(),
    status: submissionStatusEnum("status").notNull().default("queued"),
    overall: verdictEnum("overall"),
    ...timestamps,
  },
  (t) => [
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
export type Submission = typeof submissions.$inferSelect;
export type TestResultRow = typeof testResults.$inferSelect;
export type NewTestResult = typeof testResults.$inferInsert;
