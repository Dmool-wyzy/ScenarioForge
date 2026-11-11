import type { ModelDiagnostic } from "../model-diagnostics";
import type { ExecutionProgress } from "./types";

export function modelDiagnosticProgress(diagnostic: ModelDiagnostic, scope: string, timeoutSeconds: number, manualBudget: boolean): { message: string; progress: ExecutionProgress } {
  const round = `第 ${diagnostic.requestNumber} 轮模型请求`;
  const message = diagnostic.phase === "started" ? `${round}：等待模型服务响应`
    : diagnostic.phase === "headers" ? `${round}：已收到响应头，等待完整结果`
    : diagnostic.phase === "completed" ? `${round}：完整结果已返回`
    : diagnostic.incompleteReason === "max_output_tokens" ? `${round}：输出预算耗尽，未完成的结果不会执行`
    : diagnostic.incompleteReason === "content_filter" ? `${round}：服务商终止了本轮输出`
    : diagnostic.failureKind === "incomplete" ? `${round}：模型返回未完成结果`
    : diagnostic.failureKind === "timeout" ? `${round}：连接或响应超时`
    : `${round}：未完成，请查看任务错误信息`;
  return { message, progress: {
    operationId: `${scope}-${diagnostic.requestNumber}`, action: "model_request",
    phase: diagnostic.phase === "completed" || diagnostic.phase === "failed" ? diagnostic.phase : "waiting",
    ...(diagnostic.durationMs !== undefined ? { durationMs: diagnostic.durationMs } : {}),
    model: { ...diagnostic, timeoutSeconds, budgetMode: manualBudget ? "manual" : "auto" },
  } };
}
