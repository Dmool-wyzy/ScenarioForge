import "server-only";
import { ApiError } from "./errors";
import { readFilePlan } from "./file-plan";

export function taskOutcome(current: { status: string; currentStage: number; researchPlan: string | null }, usedResearch: boolean, filenames: string[]) {
  if (["waiting_for_user", "blocked", "waiting_for_edit"].includes(current.status)) return { status: current.status, currentStage: current.currentStage };
  if (!usedResearch) return { status: current.status === "created" || (current.status === "failed" && !current.researchPlan) ? "replied" : current.status, currentStage: current.currentStage };
  const plan = readFilePlan(current.researchPlan ? JSON.parse(current.researchPlan) : null);
  if (!plan.length) throw new ApiError(502, "研究计划尚未成功保存，Agent 已结束本轮。请检查前面的工具执行进度及 MCP 服务日志后再继续研究。");
  const missing = plan.filter(item => !filenames.includes(item.filename));
  if (missing.length) throw new ApiError(502, `Agent 本轮结束但未完成文件计划：缺少 ${missing.map(item => item.filename).join("、")}，请继续研究。`);
  return { status: "completed", currentStage: 4 };
}
