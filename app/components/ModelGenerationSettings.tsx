"use client";

import { useCallback, useState } from "react";

export type ReasoningEffort = "auto" | "default" | "none" | "low" | "medium" | "high" | "max";
export type ModelGenerationSettings = { reasoningEffort?: ReasoningEffort; maxOutputTokens?: number | null };
const effortLabels: Record<ReasoningEffort, string> = { auto: "自动", default: "服务商默认", none: "关闭思考", low: "低", medium: "中", high: "高", max: "最高" };

function isDeepSeek(baseUrl: string) {
  try { return new URL(baseUrl).hostname === "api.deepseek.com"; } catch { return false; }
}

export function generationSettingsSummary(settings: ModelGenerationSettings & { baseUrl: string; timeoutSeconds: number }) {
  const effort = settings.reasoningEffort ?? "auto";
  const reasoning = effort === "auto" ? isDeepSeek(settings.baseUrl) ? "自动（关闭思考，优先响应）" : "自动（服务商默认）"
    : effort === "default" && isDeepSeek(settings.baseUrl) ? "服务商默认（高强度思考）" : effortLabels[effort];
  return `超时 ${settings.timeoutSeconds} 秒 · 思考：${reasoning} · 输出上限：${settings.maxOutputTokens == null ? "自动预算" : `${settings.maxOutputTokens.toLocaleString("en-US")} tokens（含思考）`}`;
}

export function useModelGenerationSettings() {
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
  const [customOutput, setCustomOutput] = useState(false);
  const [outputTokens, setOutputTokens] = useState("8192");
  const applyGenerationSettings = useCallback((settings: ModelGenerationSettings | null) => {
    setReasoningEffort(settings?.reasoningEffort ?? "auto");
    setCustomOutput(settings?.maxOutputTokens != null);
    setOutputTokens(String(settings?.maxOutputTokens ?? 8192));
  }, []);
  return { reasoningEffort, setReasoningEffort, customOutput, setCustomOutput, outputTokens, setOutputTokens, applyGenerationSettings,
    generationSettings: { reasoningEffort, maxOutputTokens: customOutput ? Number(outputTokens) : null } };
}

export default function ModelGenerationSettingsFields({ id, baseUrl, reasoningEffort, onReasoningChange, customOutput, onCustomOutputChange, outputTokens, onOutputTokensChange, disabled }: {
  id: string; baseUrl: string; reasoningEffort: ReasoningEffort; onReasoningChange: (effort: ReasoningEffort) => void;
  customOutput: boolean; onCustomOutputChange: (custom: boolean) => void; outputTokens: string; onOutputTokensChange: (tokens: string) => void; disabled: boolean;
}) {
  const deepseek = isDeepSeek(baseUrl);
  const efforts: ReasoningEffort[] = deepseek ? ["auto", "default", "none", "low", "high", "max"] : ["auto", "default", "none", "low", "medium", "high", "max"];
  return <section aria-label="模型生成设置" className="mt-5 rounded-lg border border-[#e3e8db] p-4">
    <div className="grid gap-5 md:grid-cols-2">
      <div><label htmlFor={`${id}-reasoning`}>思考强度<select id={`${id}-reasoning`} value={reasoningEffort} onChange={event => onReasoningChange(event.target.value as ReasoningEffort)} disabled={disabled}>
        {deepseek && reasoningEffort === "medium" && <option value="medium" disabled>中（此服务商不支持，请重新选择）</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
      </select></label><p className="mt-2 text-[11px] leading-6 text-[#65735d]">自动：官方 DeepSeek 关闭思考、优先响应；其他服务商沿用默认。{deepseek ? "选择“服务商默认”会启用 DeepSeek 默认的高强度思考。" : "指定强度需当前模型与协议支持。"}</p></div>
      <div><label htmlFor={`${id}-output-mode`}>输出预算<select id={`${id}-output-mode`} value={customOutput ? "custom" : "auto"} onChange={event => onCustomOutputChange(event.target.value === "custom")} disabled={disabled}>
        <option value="auto">自动预算</option><option value="custom">自定义上限</option>
      </select></label>{customOutput && <label htmlFor={`${id}-output-tokens`} className="mt-3 block">输出上限（tokens，含思考）<input id={`${id}-output-tokens`} type="number" value={outputTokens} onChange={event => onOutputTokensChange(event.target.value)} min={512} max={65536} step={1} required disabled={disabled} /></label>}<p className="mt-2 text-[11px] leading-6 text-[#65735d]">自动预算按任务类型分配；自定义范围 512–65,536 tokens，包含思考与最终输出。较高上限可能增加等待时间和费用，仍受模型自身限制。</p></div>
    </div>
  </section>;
}
