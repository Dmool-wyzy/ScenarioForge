import "server-only";
import { z } from "zod";
import { filenameSchema } from "./validation";
import { REQUIRED_WORKSPACE_FILENAMES } from "./types";

export const filePlanItemSchema = z.object({
  filename: filenameSchema,
  purpose: z.string().trim().min(1).max(1000),
  priority: z.enum(["required", "recommended", "optional"]),
  contentOutline: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
});

export const filePlanSchema = z.array(filePlanItemSchema).min(3).max(20).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.filename.toLowerCase())).size !== items.length) {
    ctx.addIssue({ code: "custom", message: "文件计划不能包含重名文件（忽略大小写）。" });
  }
  for (const filename of REQUIRED_WORKSPACE_FILENAMES) {
    if (!items.some((item) => item.filename === filename && item.priority === "required")) {
      ctx.addIssue({ code: "custom", message: `${filename} 必须列入计划且优先级为 required。` });
    }
  }
});

export function readFilePlan(plan: unknown) {
  const result = filePlanSchema.safeParse((plan as { filePlan?: unknown } | null)?.filePlan);
  return result.success ? result.data : [];
}
