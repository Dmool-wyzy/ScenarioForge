import { z } from "zod";
import { filePlanSchema } from "./file-plan";

const question = z.object({ id: z.string().min(1).max(150).optional(), question: z.string().trim().min(1).max(1000), searchQueries: z.array(z.string().min(1).max(1000)).max(3).default([]), priority: z.enum(["high", "medium", "low"]).default("high") });
const missing = z.object({ question: z.string().min(1).max(2000), whyNeeded: z.string().max(1500), priority: z.enum(["blocking", "optional"]) });
export const planSchema = z.object({ scenarioType: z.string().max(200), researchQuestions: z.array(z.union([z.string().trim().min(1).max(1000), question])).min(3).max(6),
  searchQueries: z.array(z.string().max(1000)).min(1).max(18), unknowns: z.array(z.string().max(1000)).max(20), filePlan: filePlanSchema,
  questionDetails: z.array(question).max(6).optional(), missingInformation: z.array(missing).max(6).default([]), version: z.number().int().optional(),
}).transform(plan => {
  const details = plan.researchQuestions.map((item, index) => typeof item === "string" ? { ...plan.questionDetails?.[index], question: item, searchQueries: plan.questionDetails?.[index]?.searchQueries ?? [], priority: plan.questionDetails?.[index]?.priority ?? "high" as const } : item);
  return { ...plan, researchQuestions: details.map(item => item.question), questionDetails: details, version: 2 };
});

export function readResearchPlan(value: string | null) {
  if (!value) return null;
  const raw = JSON.parse(value);
  if (!raw.filePlan) raw.filePlan = ["README.md", "RESEARCH.md", "SOURCES.md"].map(filename => ({ filename, purpose: "兼容旧研究包的文档计划", priority: "required", contentOutline: ["核对研究证据与信息缺口"] }));
  return planSchema.parse(raw);
}
