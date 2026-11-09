import "server-only";
import OpenAI from "openai";
import { ApiError } from "./errors";
import { modelFetch, modelTransport } from "./model-endpoint";
import { modelProviderData, type ModelSettings } from "./model-settings";

export async function testModelConnection(settings: ModelSettings, address: string) {
  const transport = modelTransport(settings.baseUrl, 30000, address);
  const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl, timeout: 30000, maxRetries: 0,
    fetch: modelFetch(transport, settings.baseUrl) });
  const parameters = { type: "object" as const, properties: { ok: { type: "boolean" as const } }, required: ["ok"], additionalProperties: false };
  let argumentsText: string | undefined;
  try {
    if (settings.apiMode === "responses") {
      const result = await client.responses.create({ model: settings.model, input: "Call connection_check with ok=true. This is a connection test; do nothing else.",
        tools: [{ type: "function", name: "connection_check", description: "Validate API tool calling", parameters, strict: true }],
        tool_choice: { type: "function", name: "connection_check" }, text: { format: { type: "json_schema", name: "connection_result", schema: parameters, strict: true } }, max_output_tokens: 512 });
      const call = result.output.find(item => item.type === "function_call" && item.name === "connection_check");
      argumentsText = call?.type === "function_call" ? call.arguments : undefined;
    } else {
      const request = { model: settings.model, messages: [{ role: "user" as const, content: "Call connection_check with ok=true. This is a connection test; do nothing else." }],
        tools: [{ type: "function" as const, function: { name: "connection_check", description: "Validate API tool calling", parameters } }],
        tool_choice: { type: "function" as const, function: { name: "connection_check" } }, max_tokens: 512, ...modelProviderData(settings) };
      const result = await client.chat.completions.create(request);
      const call = result.choices[0]?.message.tool_calls?.find(item => item.type === "function" && item.function.name === "connection_check");
      argumentsText = call?.type === "function" ? call.function.arguments : undefined;
    }
    if (!argumentsText || JSON.parse(argumentsText).ok !== true) throw new ApiError(422, "接口已响应，但未通过工具调用检查。请核对模型和协议后再试。");
    return { ok: true, message: "API 鉴权与工具调用测试通过，可保存配置后发起研究。" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ApiError(504, "模型测试超过 30 秒，未自动重试。");
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) throw new ApiError(422, "API 鉴权失败或账号无权访问该模型，请检查密钥及模型权限。");
    if (error instanceof OpenAI.RateLimitError) throw new ApiError(429, "模型服务限流或额度不足，请检查服务商账户。");
    if (error instanceof OpenAI.APIConnectionError) throw new ApiError(502, "无法连接模型接口，请检查地址、证书及服务器网络。");
    if (error instanceof OpenAI.APIError && error.status && error.status >= 500) throw new ApiError(502, `模型服务返回 HTTP ${error.status}，服务端暂时无法完成请求，未自动重试。请稍后重测或查询服务商状态。`);
    throw new ApiError(422, "模型接口未通过测试，请检查 API 地址、模型 ID、协议及工具调用支持。");
  } finally { await transport.destroy(); }
}
