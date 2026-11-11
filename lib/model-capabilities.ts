import "server-only";
import { ApiError } from "./errors";

type ProtocolSettings = { baseUrl: string; apiMode: "responses" | "chat_completions" };

// Capabilities belong to a provider AND a protocol. Unknown compatible
// providers must be tested; Chat Completions is not universally schema-less.
export function assertStructuredOutputSupported(settings: ProtocolSettings) {
  if (new URL(settings.baseUrl).hostname === "api.deepseek.com" && settings.apiMode === "chat_completions") {
    throw new ApiError(422, "DeepSeek Chat Completions 不支持本功能要求的严格 JSON Schema 输出，未调用模型。请在模型设置中选择并测试 Responses API 后保存，再生成方案文档；系统不会自动切换协议或降级输出格式。");
  }
}
