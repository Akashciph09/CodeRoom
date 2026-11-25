import { z } from "zod";

export const SummarySection = z.enum(["went_well", "difficulties", "follow_up"]);
export const ModelSummaryItem = z.object({
  section: SummarySection,
  text: z.string().trim().min(1).max(400),
  citations: z.array(z.string().max(120)).min(1).max(4),
}).strict();

export const InterviewSummary = z.object({
  items: z.array(ModelSummaryItem.extend({
    text: z.string().trim().min(1).max(2000),
    citations: z.array(z.object({ anchor: z.string(), label: z.string() })).min(1).max(4),
  })).max(9),
});
export type InterviewSummary = z.infer<typeof InterviewSummary>;

export const InterviewSummaryDraft = InterviewSummary.extend({
  revision: z.number().int().positive(),
});
export type InterviewSummaryDraft = z.infer<typeof InterviewSummaryDraft>;

export const SummaryDraftRevision = z.object({ revision: z.number().int().positive() }).strict();
export const EditSummaryDraftRequest = SummaryDraftRevision.extend({
  texts: z.array(z.string().trim().min(1).max(2000)).min(1).max(9),
});
export type EditSummaryDraftRequest = z.infer<typeof EditSummaryDraftRequest>;
