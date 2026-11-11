import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { ApiError } from "./errors";
import { modelFetch, modelTransport } from "./model-endpoint";
import { modelResponseFetch } from "./model-response";
import { modelProviderData, type ModelSettings } from "./model-settings";
import { assertStructuredOutputSupported } from "./model-capabilities";
import { isOfficialDeepSeek, probeOutputTokenLimit, resolveReasoningEffort } from "./model-policy";

export const modelTestKindSchema = z.enum(["connection", "tools", "structured_output"]).default("connection");
export const modelTestRequestSchema = z.object({ testKind: modelTestKindSchema }).passthrough();
export type ModelTestKind = z.infer<typeof modelTestKindSchema>;
const labels: Record<ModelTestKind, string> = { connection: "基础连接", tools: "工具调用", structured_output: "结构化输出" };
const parameters = { type: "object" as const, properties: { ok: { type: "boolean" as const } }, required: ["ok"], additionalProperties: false };
const probeOutput = z.object({ ok: z.literal(true) }).strict();

function validProbeJson(value: string | undefined) {
  if (!value) return false;
  try { return probeOutput.safeParse(JSON.parse(value)).success; } catch { return false; }
}

// Upstream bodies can echo credentials or prompts. Only recognized parameter
// names, never raw diagnostics, are safe to return to the settings page.
function rejectedParameter(error: { param?: string | null }) {
  const param = error.param;
  if (typeof param !== "string") return undefined;
  const fields = ["model", "input", "messages", "tools", "tool_choice", "text", "response_format", "reasoning", "reasoning_effort", "thinking", "max_tokens", "max_output_tokens", "parallel_tool_calls", "store"];
  return fields.find(field => param === field || param.startsWith(`${field}.`) || param.startsWith(`${field}[`));
}

export async function testModelConnection(settings: ModelSettings, address: string, testKind: ModelTestKind = "connection") {
  if (testKind === "structured_output") assertStructuredOutputSupported(settings);
  const timeoutSeconds = Math.min(settings.timeoutSeconds, 60);
  const maxTokens = probeOutputTokenLimit(settings);
  const deepseekChatThinking = settings.apiMode === "chat_completions" && isOfficialDeepSeek(settings.baseUrl) && resolveReasoningEffort(settings) !== "none";
  const transport = modelTransport(settings.baseUrl, timeoutSeconds * 1000, address);
  const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl, timeout: timeoutSeconds * 1000, maxRetries: 0,
    fetch: modelResponseFetch(modelFetch(transport, settings.baseUrl), settings.apiMode) });
  const protocol = settings.apiMode === "responses" ? "Responses API" : "Chat Completions";
  const label = `${protocol} · ${labels[testKind]}`;
  const prompt = testKind === "tools" ? "Call connection_check with ok=true. This is a capability test; do nothing else."
    : testKind === "structured_output" ? 'Return only the JSON object {"ok":true}. This is a capability test; do nothing else.'
    : "Reply with OK. This is a connection test; do nothing else.";
  let text: string | undefined;
  let argumentsText: string | undefined;
  try {
    if (settings.apiMode === "responses") {
      const result = await client.responses.create({ model: settings.model, input: prompt, max_output_tokens: maxTokens,
        ...modelProviderData(settings),
        ...(testKind === "tools" ? {
          tools: [{ type: "function" as const, name: "connection_check", description: "Validate API tool calling", parameters, strict: true }],
          tool_choice: { type: "function" as const, name: "connection_check" },
        } : {}),
        ...(testKind === "structured_output" ? { text: { format: { type: "json_schema" as const, name: "connection_result", schema: parameters, strict: true } } } : {}),
      });
      if (result.status !== "completed") throw new ApiError(422, `${label}未完成（${result.status === "incomplete" ? "输出被截断" : "响应未完成"}），未自动重试。`);
      text = result.output.filter(item => item.type === "message").flatMap(item => item.content.filter(part => part.type === "output_text").map(part => part.text)).join("");
      const call = result.output.find(item => item.type === "function_call" && item.name === "connection_check");
      argumentsText = call?.type === "function_call" ? call.arguments : undefined;
    } else {
      const result = await client.chat.completions.create({ model: settings.model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, ...modelProviderData(settings),
        ...(testKind === "tools" ? {
          tools: [{ type: "function" as const, function: { name: "connection_check", description: "Validate API tool calling", parameters, strict: true } }],
          // DeepSeek rejects a forced function in thinking mode. The response
          // must still contain the actual named call before the probe passes.
          tool_choice: deepseekChatThinking ? "auto" as const : { type: "function" as const, function: { name: "connection_check" } },
        } : {}),
        ...(testKind === "structured_output" ? { response_format: { type: "json_schema" as const, json_schema: { name: "connection_result", schema: parameters, strict: true } } } : {}),
      });
      const choice = result.choices[0];
      if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) throw new ApiError(422, `${label}未完成或输出被截断，未自动重试。`);
      text = choice.message.content ?? undefined;
      const call = choice.message.tool_calls?.find(item => item.type === "function" && item.function.name === "connection_check");
      argumentsText = call?.type === "function" ? call.function.arguments : undefined;
    }
    const valid = testKind === "tools" ? validProbeJson(argumentsText) : testKind === "structured_output" ? validProbeJson(text) : !!text?.trim();
    if (!valid) throw new ApiError(422, `${label}未通过：接口已响应，但未返回符合本项要求的${testKind === "tools" ? "工具参数" : testKind === "structured_output" ? "结构化文本" : "文本内容"}，未自动重试。`);
    return { ok: true as const, testKind, apiMode: settings.apiMode, message: `${label}测试通过。仅验证本项能力，测试不会自动保存配置。` };
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(error.status, error.message.startsWith(label) ? error.message : `${label}失败：${error.message}`);
    if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ApiError(504, `${label}超过 ${timeoutSeconds} 秒，未自动重试。请检查服务器网络或服务商响应情况。`);
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) throw new ApiError(422, `${label}失败（HTTP ${error.status}）：API 鉴权失败或账号无权访问该模型，请检查密钥及模型权限。`);
    if (error instanceof OpenAI.RateLimitError) throw new ApiError(429, `${label}失败（HTTP 429）：模型服务限流或额度不足，请检查服务商账户。`);
    if (error instanceof OpenAI.APIConnectionError) throw new ApiError(502, `${label}失败：${error.cause instanceof ApiError ? error.cause.message : "无法连接模型接口，请检查地址、证书及服务器网络。"}`);
    if (error instanceof OpenAI.APIError) {
      const status = Number.isInteger(error.status) && error.status! >= 400 && error.status! <= 599 ? `HTTP ${error.status}` : "上游请求失败";
      const parameter = rejectedParameter(error);
      throw new ApiError(error.status && error.status >= 500 ? 502 : 422, `${label}失败（${status}）${parameter ? `，服务商拒绝的参数：${parameter}` : ""}。请核对该协议、模型及本项能力的支持情况；未自动重试或切换协议。`);
    }
    throw new ApiError(422, `${label}未通过，请检查模型接口响应与本项能力的支持情况；未自动重试。`);
  } finally { await transport.destroy(); }
}
