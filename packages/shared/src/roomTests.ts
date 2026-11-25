import { z } from "zod";

export const MAX_ROOM_TEST_CASES = 10;
const text = (max: number) => z.string().max(max).refine((value) => !value.includes("\0"));

export const RoomTestSuggestion = z.object({
  input: text(4096),
  expectedOutput: text(4096).refine((value) => Boolean(value.trim())),
  reason: text(500).refine((value) => Boolean(value.trim())),
}).strict();
export type RoomTestSuggestion = z.infer<typeof RoomTestSuggestion>;

export const RoomTestCase = RoomTestSuggestion.omit({ reason: true }).extend({
  id: z.string().uuid(),
  isHidden: z.boolean(),
});
export type RoomTestCase = z.infer<typeof RoomTestCase>;

export const AddRoomTestRequest = RoomTestCase.omit({ id: true }).extend({
  confirmed: z.boolean().default(false),
  referencePython: text(12_000).refine((value) => Boolean(value.trim())).optional(),
}).strict().refine((value) => value.confirmed || Boolean(value.referencePython), {
  path: ["confirmed"],
  message: "Confirm the expected output or supply a trusted Python reference.",
});
export type AddRoomTestRequest = z.input<typeof AddRoomTestRequest>;

export const RoomTestSuggestions = z.object({ tests: z.array(RoomTestSuggestion).length(3) }).strict();
export type RoomTestSuggestions = z.infer<typeof RoomTestSuggestions>;
