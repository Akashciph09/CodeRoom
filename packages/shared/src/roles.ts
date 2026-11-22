import { z } from "zod";

export const Role = z.enum(["interviewer", "candidate"]);
export type Role = z.infer<typeof Role>;
