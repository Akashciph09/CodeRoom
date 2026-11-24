import { z } from "zod";

export const SummarySection = z.enum(["went_well", "difficulties", "follow_up"]);
export const ModelSummaryItem = z.object({
  section: SummarySection,
  text: z.string().trim().min(1).max(400),
  citations: z.array(z.string().max(120)).min(1).max(4),
}).strict();

export const InterviewSummary = z.object({
  items: z.array(ModelSummaryItem.extend({
    citations: z.array(z.object({ anchor: z.string(), label: z.string() })).min(1).max(4),
  })).max(9),
});
export type InterviewSummary = z.infer<typeof InterviewSummary>;
