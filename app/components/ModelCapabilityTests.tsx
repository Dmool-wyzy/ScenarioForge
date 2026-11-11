"use client";

import { useCallback, useState } from "react";

export type ModelTestKind = "connection" | "tools" | "structured_output";
export type ModelTestResponse = { ok: true; testKind: ModelTestKind; apiMode: "responses" | "chat_completions"; message: string };
type TestResult = { passed: boolean; message: string };
type TestResults = Partial<Record<ModelTestKind, TestResult>>;
const testLabels: Record<ModelTestKind, string> = { connection: "基础连接", tools: "工具调用", structured_output: "结构化输出" };
const testKinds = Object.keys(testLabels) as ModelTestKind[];

export function useModelCapabilityTests() {
  const [testKind, setTestKind] = useState<ModelTestKind>("connection");
  const [results, setResults] = useState<TestResults>({});
  const resetTests = useCallback(() => setResults({}), []);
  const recordTest = (kind: ModelTestKind, passed: boolean, message: string) => setResults(current => ({ ...current, [kind]: { passed, message } }));
  return { testKind, setTestKind, results, resetTests, recordTest };
}

export function isDeepSeekChat(baseUrl: string, apiMode: string) {
  try { return apiMode === "chat_completions" && new URL(baseUrl).hostname === "api.deepseek.com"; } catch { return false; }
}

export default function ModelCapabilityTests({ id, testKind, onTestKindChange, results, pending, disabled, baseUrl, apiMode }: {
  id: string; testKind: ModelTestKind; onTestKindChange: (kind: ModelTestKind) => void; results: TestResults;
  pending: boolean; disabled: boolean; baseUrl: string; apiMode: string;
}) {
  return <section aria-label="模型能力测试" className="mt-5 rounded-lg border border-[#e3e8db] p-4">
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={`${id}-test-kind`} className="min-w-44 flex-1">测试项目<select id={`${id}-test-kind`} name="modelTestKind" value={testKind} onChange={event => onTestKindChange(event.target.value as ModelTestKind)} disabled={disabled}>
        {testKinds.map(kind => <option key={kind} value={kind}>{testLabels[kind]}</option>)}
      </select></label>
      <button type="submit" name="action" value="test" className="secondary" disabled={disabled}>{pending ? `正在测试${testLabels[testKind]}…` : `测试${testLabels[testKind]}`}</button>
    </div>
    <p className="mt-3 text-[11px] leading-6 text-[#65735d]">每次只测试所选项目，向当前协议发送一次最小请求，可能产生少量费用。测试使用当前草稿的思考设置，但最多等待 60 秒并使用较小输出预算，不按实际任务的完整预算运行。测试不会保存配置或自动切换协议；修改配置后需重新测试。</p>
    <p className="mt-1 text-[11px] leading-6 text-[#65735d]">工具项检查 Agent 使用的严格函数参数；结构化输出项检查 JSON Schema 文本。最小测试通过后，具体任务仍可能受上下文长度、复杂参数、思考强度或输出预算限制。</p>
    {isDeepSeekChat(baseUrl, apiMode) && <p className="mt-3 rounded-lg bg-[#fff5ed] px-3 py-2 text-xs leading-6 text-[#9d5944]">DeepSeek Chat Completions 不支持当前文档生成所需的严格 JSON Schema，方案文档生成不可用。可手动选择 Responses API 后分别测试；基础连接或工具调用通过不能代表文档生成可用。</p>}
    <ul aria-label="当前配置的测试结果" aria-live="polite" className="mt-4 space-y-3 text-xs">
      {testKinds.map(kind => {
        const result = results[kind], running = pending && kind === testKind;
        return <li key={kind} className="leading-6"><span className="font-medium text-[#344631]">{testLabels[kind]}</span><span className={`ml-2 ${running || !result ? "text-[#65735d]" : result.passed ? "text-[#45633c]" : "text-[#9d5944]"}`}>{running ? "测试中" : result ? result.passed ? "已通过" : "未通过" : "未测试"}</span>{!running && result && <p className="break-words text-[#65735d]">{result.message}</p>}</li>;
      })}
    </ul>
  </section>;
}
