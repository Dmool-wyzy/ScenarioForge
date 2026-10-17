import "server-only";
import { ZodError } from "zod";
import { SearchProviderError } from "./search/types";
import { ToolCallError } from "@openai/agents";
import OpenAI from "openai";
import { projectModelEnv } from "./model-env";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function logError(error: unknown) {
  let detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  try {
    const key = projectModelEnv().OPENAI_API_KEY;
    if (key) detail = detail.split(key).join("[REDACTED]");
  } catch { /* Configuration errors still need to be logged. */ }
  for (const name of ["OPENAI_API_KEY", "EMBEDDING_API_KEY", "TAVILY_API_KEY", "SCENARIOFORGE_INTERNAL_TOKEN"]) {
    const secret = process.env[name];
    if (secret) detail = detail.split(secret).join("[REDACTED]");
  }
  console.error("[ScenarioForge]", detail.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]"));
}

export function publicError(error: unknown) {
  if (error instanceof ToolCallError && error.error instanceof ApiError) return error.error.message;
  if (error instanceof SearchProviderError) return error.message;
  if (error instanceof ApiError) return error.message;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "模型服务连接或响应超时，已保留证据和已生成文件；本轮已停止，未自动重试。请检查模型服务地址及网络后继续。";
  if (error instanceof OpenAI.RateLimitError) return "模型服务限流或额度不足，本轮已停止，未自动重试。请检查服务商额度后继续。";
  if (error instanceof OpenAI.APIConnectionError) return "无法连接模型服务，本轮已停止，未自动重试。请检查模型服务地址及网络后继续；已有证据和文件保留。";
  if (error instanceof OpenAI.AuthenticationError) return "模型服务认证失败，本轮已停止。请检查项目专用 API key 和模型服务地址。";
  if (error instanceof OpenAI.APIError) return "模型服务返回错误，本轮已停止，未自动重试。请检查模型名、API 模式及服务商状态。";
  if (error instanceof ZodError) return "输入格式不正确或超过长度限制，请检查后重试。";
  if (error instanceof Error && error.message.startsWith("环境变量缺失或无效：")) return error.message;
  if (error instanceof Error && error.message.startsWith("SEARCH_PROVIDER 无效")) return error.message;
  return "服务暂时无法完成请求，请检查服务端配置或稍后重试。";
}

export function errorResponse(error: unknown) {
  logError(error);
  if (error instanceof SearchProviderError) return Response.json({ error: error.message, provider: error.provider, code: error.code }, { status: error.code === "missing_config" ? 503 : error.code === "rate_limited" ? 429 : 502 });
  return Response.json({ error: publicError(error), ...(error instanceof ApiError && "code" in error ? { code: error.code } : {}) }, { status: error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500 });
}
