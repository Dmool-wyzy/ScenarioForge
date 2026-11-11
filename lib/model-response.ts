import "server-only";
import { z } from "zod";
import { ApiError } from "./errors";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const knownResponseItems: Record<string, z.ZodType> = {
  message: z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("output_text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough(),
  ])) }).passthrough(),
  function_call: z.object({ call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }).passthrough(),
  reasoning: z.object({ summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).passthrough()) }).passthrough(),
};
const responseItemSchema = z.object({ type: z.string().min(1) }).passthrough().superRefine((item, context) => {
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

// Some compatible gateways return a complete JSON envelope with a text media
// type, or JSON-encode that envelope one extra time. Normalize only successful
// non-streaming model responses; never turn error pages into successful output.
export function modelResponseFetch(fetchImplementation: typeof globalThis.fetch, apiMode: "responses" | "chat_completions"): typeof globalThis.fetch {
  return async (input, init) => {
    const streaming = await modelRequestIsStreaming(input, init);
    const response = await fetchImplementation(input, init);
    if (!response.ok || streaming) return response;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new ApiError(502, "模型响应超过 8 MiB 限制，本轮已停止，未自动重试。");
          chunks.push(item.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof envelope === "string") envelope = JSON.parse(envelope);
    } catch {
      throw new ApiError(502, "模型服务已响应，但返回内容不是有效的模型 JSON 响应；本轮已停止，未自动重试。请检查接口协议或网关响应格式。");
    }
    if (!(apiMode === "responses" ? responseSchema : chatSchema).safeParse(envelope).success) throw new ApiError(502, "模型服务已响应，但响应结构不符合所选的 Responses 或 Chat Completions 协议；本轮已停止，未自动重试。请检查模型及接口协议。");
    const headers = new Headers(response.headers), body = JSON.stringify(envelope);
    headers.delete("Content-Encoding");
    headers.delete("Transfer-Encoding");
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Length", String(Buffer.byteLength(body)));
    const normalized = new Response(body, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperty(normalized, "url", { value: response.url });
    return normalized;
  };
}
