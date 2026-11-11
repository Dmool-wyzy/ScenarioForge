export const REASONING_EFFORTS = ["auto", "default", "none", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type EffectiveReasoningEffort = Exclude<ReasoningEffort, "auto" | "default">;
export const REASONING_EFFORT_OPTIONS: readonly { value: ReasoningEffort; label: string }[] = [
  { value: "auto", label: "自动（DeepSeek 关闭思考）" },
  { value: "default", label: "服务商默认" },
  { value: "none", label: "关闭思考" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "max", label: "最高" },
];
export const MIN_MODEL_OUTPUT_TOKENS = 512;
export const MAX_MODEL_OUTPUT_TOKENS = 65536;
export type ModelPolicySettings = {
  baseUrl: string;
  apiMode: "responses" | "chat_completions";
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number | null;
};

export function isOfficialDeepSeek(baseUrl: string) {
  try { return new URL(baseUrl).hostname === "api.deepseek.com"; } catch { return false; }
}

export function modelPolicyFromConfig(config: {
  OPENAI_BASE_URL: string;
  OPENAI_API_MODE: ModelPolicySettings["apiMode"];
  MODEL_REASONING_EFFORT?: ReasoningEffort;
  MODEL_MAX_OUTPUT_TOKENS?: number;
}): ModelPolicySettings {
  return { baseUrl: config.OPENAI_BASE_URL, apiMode: config.OPENAI_API_MODE,
    reasoningEffort: config.MODEL_REASONING_EFFORT ?? "auto", maxOutputTokens: config.MODEL_MAX_OUTPUT_TOKENS ?? null };
}

export function resolveReasoningEffort(settings: ModelPolicySettings): EffectiveReasoningEffort | undefined {
  const effort = settings.reasoningEffort ?? "auto";
  if (effort === "default") return undefined;
  if (effort === "auto") return isOfficialDeepSeek(settings.baseUrl) ? "none" : undefined;
  if (effort === "medium" && isOfficialDeepSeek(settings.baseUrl)) throw new Error("DeepSeek 未提供独立的中等思考档位，请选择关闭、低、高或最高。");
  return effort;
}

export function resolveModelOutputTokens(settings: ModelPolicySettings, fallback: number) {
  const limit = settings.maxOutputTokens;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit < MIN_MODEL_OUTPUT_TOKENS || limit > MAX_MODEL_OUTPUT_TOKENS) throw new Error("模型输出上限须为 512 到 65536 之间的整数。");
    return limit;
  }
  const effort = resolveReasoningEffort(settings);
  const thinkingMinimum = effort === "high" || effort === "max" || (!effort && isOfficialDeepSeek(settings.baseUrl)) ? 32768
    : effort === "medium" ? 16384 : effort === "low" ? 8192 : 0;
  return Math.max(fallback, thinkingMinimum);
}

// A capability probe uses the chosen thinking mode, with enough room for a
// small answer after reasoning. A manual output cap is never exceeded.
export function probeOutputTokenLimit(settings: ModelPolicySettings) {
  const effort = resolveReasoningEffort(settings);
  const budget = effort === "max" ? 16384 : effort === "high" || !effort ? 8192
    : effort === "medium" ? 4096 : effort === "low" ? 2048 : 512;
  return Math.min(budget, resolveModelOutputTokens(settings, budget));
}

export function modelProtocolProviderData(settings: ModelPolicySettings) {
  const effort = resolveReasoningEffort(settings);
  if (!effort) return {};
  if (settings.apiMode === "responses") return { reasoning: { effort } };
  if (isOfficialDeepSeek(settings.baseUrl)) return effort === "none"
    ? { thinking: { type: "disabled" as const } }
    : { thinking: { type: "enabled" as const }, reasoning_effort: effort };
  return { reasoning_effort: effort };
}
