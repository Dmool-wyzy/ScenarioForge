import "server-only";
import { ApiError } from "./errors";

export type ModelDiagnostic = {
  requestNumber: number;
  apiMode: "responses" | "chat_completions";
  phase: "started" | "headers" | "completed" | "failed";
  requestBytes?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  headersDurationMs?: number;
  durationMs?: number;
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  failureKind?: "incomplete" | "failed" | "empty_output" | "invalid_response" | "response_too_large" | "http_error" | "timeout" | "aborted" | "network_error";
  incompleteReason?: "max_output_tokens" | "content_filter" | "unknown";
};

export type ModelDiagnosticOptions = { onDiagnostic?: (diagnostic: ModelDiagnostic) => void | Promise<void> };

// Diagnostics deliberately contain no provider strings, response bodies,
// credentials, headers, identifiers or request/conversation content.
export class ModelResponseError extends ApiError {
  constructor(status: number, message: string, public readonly diagnostic: ModelDiagnostic) {
    super(status, message);
    this.name = "ModelResponseError";
  }
}

export function modelTokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}

export function modelReasoningEffort(value: unknown): ModelDiagnostic["reasoningEffort"] {
  return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ModelDiagnostic["reasoningEffort"] : undefined;
}
