import "server-only";
import { z } from "zod";
import { ModelResponseError, modelReasoningEffort, modelTokenCount, type ModelDiagnostic, type ModelDiagnosticOptions } from "./model-diagnostics";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const reasoningContentSchema = z.object({ content: z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() }).passthrough()) }).passthrough();
const knownResponseItems: Record<string, z.ZodType> = {
  message: z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("output_text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough(),
  ])) }).passthrough(),
  function_call: z.object({ call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }).passthrough(),
  reasoning: z.object({ summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).passthrough()) }).passthrough(),
};
const responseItemSchema = z.object({ type: z.string().min(1) }).passthrough().transform(item => {
  // DeepSeek Responses returns reasoning.content rather than a summary. The
  // Agents SDK requires summary.map, but preserves content for the next turn.
  // Keep that content intact without presenting private reasoning as a summary.
  if (item.type === "reasoning" && !Object.hasOwn(item, "summary") && reasoningContentSchema.safeParse(item).success) return { ...item, summary: [] };
  return item;
}).superRefine((item, context) => {
  // Guard the fields that the SDK consumes directly. Other hosted/future item
  // types and provider fields remain intact for the SDK's own handling.
  if (Object.hasOwn(knownResponseItems, item.type) && !knownResponseItems[item.type].safeParse(item).success) context.addIssue({ code: "custom", message: "Invalid model output item" });
});
const responseSchema = z.object({
  id: z.string().min(1), object: z.literal("response"),
  status: z.enum(["completed", "failed", "incomplete", "in_progress", "queued", "cancelled"]),
  output: z.array(responseItemSchema),
}).passthrough();
const chatSchema = z.object({
  id: z.string().min(1), object: z.literal("chat.completion"),
  choices: z.array(z.object({ message: z.object({
    role: z.literal("assistant"), content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ type: z.string().min(1) }).passthrough().superRefine((call, context) => {
      if (call.type === "function" && !z.object({ id: z.string().min(1), function: z.object({ name: z.string().min(1), arguments: z.string() }).passthrough() }).safeParse(call).success) context.addIssue({ code: "custom", message: "Invalid model tool call" });
    })).optional(),
  }).passthrough() }).passthrough()).min(1),
}).passthrough();
export async function modelRequestIsStreaming(input: RequestInfo | URL, init?: RequestInit) {
  try {
    if (typeof init?.body === "string") return JSON.parse(init.body)?.stream === true;
    if (init?.body === undefined && typeof input !== "string" && !(input instanceof URL)) return (await input.clone().json())?.stream === true;
  } catch { /* The underlying client handles an invalid request body. */ }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function requestMetadata(input: RequestInfo | URL, init?: RequestInit) {
  let body: string | undefined;
  try {
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body === undefined && typeof input !== "string" && !(input instanceof URL)) body = await input.clone().text();
  } catch { /* The client validates unsupported request body types. */ }
  let request: Record<string, unknown> = {};
  try { if (body !== undefined) request = record(JSON.parse(body)); } catch { /* Never include a malformed request in diagnostics. */ }
  return {
    streaming: request.stream === true,
    requestBytes: body === undefined ? undefined : Buffer.byteLength(body),
    maxOutputTokens: modelTokenCount(request.max_output_tokens ?? request.max_tokens),
    reasoningEffort: modelReasoningEffort(record(request.reasoning).effort ?? request.reasoning_effort),
  };
}

function responseUsage(value: unknown, apiMode: ModelDiagnostic["apiMode"]) {
  const usage = record(record(value).usage);
  return {
    inputTokens: modelTokenCount(apiMode === "responses" ? usage.input_tokens : usage.prompt_tokens),
    outputTokens: modelTokenCount(apiMode === "responses" ? usage.output_tokens : usage.completion_tokens),
    reasoningTokens: modelTokenCount(record(apiMode === "responses" ? usage.output_tokens_details : usage.completion_tokens_details).reasoning_tokens),
  };
}

function terminalFailure(envelope: unknown, apiMode: ModelDiagnostic["apiMode"]): Pick<ModelDiagnostic, "failureKind" | "incompleteReason"> | null {
  const response = record(envelope);
  if (apiMode === "responses") {
    if (response.status === "incomplete") {
      const reason = record(response.incomplete_details).reason;
      return { failureKind: "incomplete", incompleteReason: reason === "max_output_tokens" || reason === "content_filter" ? reason : "unknown" };
    }
    if (["failed", "cancelled", "in_progress", "queued"].includes(String(response.status))) return { failureKind: "failed" };
    if (response.status === "completed" && Array.isArray(response.output)) {
      const hasOutput = response.output.some(value => {
        const item = record(value);
        if (["function_call", "custom_tool_call"].includes(String(item.type))) return true;
        return item.type === "message" && Array.isArray(item.content) && item.content.some(value => {
          const content = record(value);
          return (content.type === "output_text" && typeof content.text === "string" && content.text.trim().length > 0) || content.type === "refusal";
        });
      });
      // A reasoning-only response must not become an empty successful final answer.
      if (!hasOutput) return { failureKind: "empty_output" };
    }
  } else if (Array.isArray(response.choices)) {
    const first = record(response.choices[0]);
    if (first.finish_reason === "length") return { failureKind: "incomplete", incompleteReason: "max_output_tokens" };
    if (first.finish_reason === "content_filter") return { failureKind: "incomplete", incompleteReason: "content_filter" };
  }
  return null;
}

function failureMessage(diagnostic: ModelDiagnostic) {
  if (diagnostic.failureKind === "response_too_large") return "模型响应超过 8 MiB 限制，本轮已停止，未自动重试。";
  if (diagnostic.failureKind === "invalid_response") return "模型服务已响应，但返回内容不是有效的模型 JSON 响应或不符合所选接口协议；本轮已停止，未自动重试。";
  const usage = diagnostic.outputTokens !== undefined
    ? `服务商报告输出 ${diagnostic.outputTokens} token${diagnostic.reasoningTokens !== undefined ? `，其中推理 ${diagnostic.reasoningTokens} token` : ""}。` : "";
  if (diagnostic.failureKind === "incomplete" && diagnostic.incompleteReason === "max_output_tokens") {
    return `模型输出达到本轮 token 上限而被截断${diagnostic.maxOutputTokens !== undefined ? `（请求上限 ${diagnostic.maxOutputTokens} token）` : ""}，未获得完整结果。${usage}本轮已停止，未自动重试；请缩小本轮任务或调整输出预算后手动继续。`;
  }
  if (diagnostic.failureKind === "incomplete" && diagnostic.incompleteReason === "content_filter") return "模型输出被服务商内容过滤中断，本轮已停止，未自动重试；已有文件保留。";
  if (diagnostic.failureKind === "incomplete") return `模型服务返回未完成状态，未获得完整结果。${usage}本轮已停止，未自动重试；已有文件保留。`;
  if (diagnostic.failureKind === "empty_output") return `模型服务未返回可用的最终答复或工具调用。${usage}本轮已停止，未自动重试；已有文件保留。`;
  return `模型服务返回失败或未结束状态，未获得完整结果。${usage}本轮已停止，未自动重试；已有文件保留。`;
}

// Some compatible gateways return a complete JSON envelope with a text media
// type, or JSON-encode that envelope one extra time. Normalize only successful
// non-streaming model responses; never turn error pages into successful output.
export function modelResponseFetch(fetchImplementation: typeof globalThis.fetch, apiMode: "responses" | "chat_completions", options: ModelDiagnosticOptions = {}): typeof globalThis.fetch {
  let requestNumber = 0;
  return async (input, init) => {
    const metadata = await requestMetadata(input, init);
    const signal = init?.signal ?? (typeof input !== "string" && !(input instanceof URL) ? input.signal : undefined);
    const diagnostic: ModelDiagnostic = { requestNumber: ++requestNumber, apiMode, phase: "started", requestBytes: metadata.requestBytes, maxOutputTokens: metadata.maxOutputTokens, reasoningEffort: metadata.reasoningEffort };
    let callbackFailure = false;
    const emit = async (phase: ModelDiagnostic["phase"], recordingFailure = false) => {
      if (!recordingFailure) signal?.throwIfAborted();
      diagnostic.phase = phase;
      try { await options.onDiagnostic?.({ ...diagnostic }); }
      catch (error) { callbackFailure = true; throw error; }
      if (!recordingFailure) signal?.throwIfAborted();
    };
    await emit("started");
    const startedAt = performance.now();
    try {
      const response = await fetchImplementation(input, init);
      diagnostic.httpStatus = response.status;
      diagnostic.headersDurationMs = Math.round(performance.now() - startedAt);
      try { await emit("headers"); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      // Streaming remains under the SDK's stream handling; do not claim it is
      // complete when only headers have arrived or buffer the live stream.
      if (metadata.streaming) return response;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            signal?.throwIfAborted();
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              diagnostic.failureKind = "response_too_large";
              throw new ModelResponseError(502, failureMessage(diagnostic), { ...diagnostic, phase: "failed" });
            }
            chunks.push(item.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      signal?.throwIfAborted();
      diagnostic.durationMs = Math.round(performance.now() - startedAt);
      const bytesBody = Buffer.concat(chunks);
      if (!response.ok) {
        diagnostic.failureKind = "http_error";
        await emit("failed");
        // Let the SDK preserve HTTP error classes; diagnostic events never
        // contain the error body, headers or provider-supplied messages.
        return new Response(bytesBody, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(bytesBody.toString("utf8"));
        if (typeof envelope === "string") envelope = JSON.parse(envelope);
      } catch {
        diagnostic.failureKind = "invalid_response";
        throw new ModelResponseError(502, failureMessage(diagnostic), { ...diagnostic, phase: "failed" });
      }
      Object.assign(diagnostic, responseUsage(envelope, apiMode));
      // HTTP 200 does not imply a completed model response. Check the terminal
      // status before the Agents SDK loses incomplete_details and usage.
      const failure = apiMode === "responses" && record(envelope).status === "completed" ? null : terminalFailure(envelope, apiMode);
      if (failure) {
        Object.assign(diagnostic, failure);
        throw new ModelResponseError(502, failureMessage(diagnostic), { ...diagnostic, phase: "failed" });
      }
      const parsed = (apiMode === "responses" ? responseSchema : chatSchema).safeParse(envelope);
      if (!parsed.success) {
        diagnostic.failureKind = "invalid_response";
        throw new ModelResponseError(502, failureMessage(diagnostic), { ...diagnostic, phase: "failed" });
      }
      const emptyFailure = apiMode === "responses" ? terminalFailure(parsed.data, apiMode) : null;
      if (emptyFailure) {
        Object.assign(diagnostic, emptyFailure);
        throw new ModelResponseError(502, failureMessage(diagnostic), { ...diagnostic, phase: "failed" });
      }
      const headers = new Headers(response.headers), body = JSON.stringify(parsed.data);
      headers.delete("Content-Encoding");
      headers.delete("Transfer-Encoding");
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Content-Length", String(Buffer.byteLength(body)));
      const normalized = new Response(body, { status: response.status, statusText: response.statusText, headers });
      Object.defineProperty(normalized, "url", { value: response.url });
      await emit("completed");
      return normalized;
    } catch (error) {
      if (callbackFailure) throw error;
      diagnostic.durationMs = Math.round(performance.now() - startedAt);
      if (!diagnostic.failureKind) {
        const reason = signal?.reason;
        const timeout = reason instanceof Error && reason.name === "TimeoutError" || error instanceof Error && ["TimeoutError", "HeadersTimeoutError", "BodyTimeoutError"].includes(error.name);
        diagnostic.failureKind = timeout ? "timeout" : signal?.aborted ? "aborted" : "network_error";
      }
      // Retain the original transport/model error if recording itself fails.
      // A stopped task's abort signal always takes precedence.
      if (error instanceof ModelResponseError) Object.assign(error.diagnostic, diagnostic, { phase: "failed" });
      try { await emit("failed", true); } catch { signal?.throwIfAborted(); }
      throw error;
    }
  };
}
