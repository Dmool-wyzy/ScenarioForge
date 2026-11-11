"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import PersonalTask, { type PersonalTaskData } from "./PersonalTask";
import ModelCapabilityTests, { useModelCapabilityTests, type ModelTestResponse } from "./ModelCapabilityTests";
import ModelGenerationSettingsFields, { generationSettingsSummary, useModelGenerationSettings, type ModelGenerationSettings } from "./ModelGenerationSettings";

type ApiMode = "responses" | "chat_completions";
type Settings = ModelGenerationSettings & { baseUrl: string; model: string; apiMode: ApiMode; timeoutSeconds: number; hasApiKey: boolean };
type Snapshot = { settings: Settings | null; acceptsAgentTasks: boolean; tasks: PersonalTaskData[] };

export default function PersonalAgent({ projectId, mode = "inbox" }: { projectId: string; mode?: "inbox" | "settings" }) {
  const endpoint = `/api/projects/${projectId}/personal-agent`;
  const taskEndpoint = useCallback(() => {
    const target = window.location.hash.match(/^#personal-task-([A-Za-z0-9_-]{1,100})$/)?.[1];
    return target ? `${endpoint}?task=${encodeURIComponent(target)}` : endpoint;
  }, [endpoint]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiMode, setApiMode] = useState<ApiMode>("chat_completions");
  const [timeoutSeconds, setTimeoutSeconds] = useState("120");
  const [apiKey, setApiKey] = useState("");
  const [acceptsAgentTasks, setAcceptsAgentTasks] = useState(false);
  const [pending, setPending] = useState<"save" | "test" | "clear" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [loading, setLoading] = useState(true);
  const { testKind, setTestKind, results, resetTests, recordTest } = useModelCapabilityTests();
  const generation = useModelGenerationSettings();
  const { applyGenerationSettings } = generation;
  const saved = snapshot?.settings;
  const unsaved = baseUrl.trim() !== (saved?.baseUrl ?? "") || model.trim() !== (saved?.model ?? "") || apiMode !== (saved?.apiMode ?? "chat_completions")
    || Number(timeoutSeconds) !== (saved?.timeoutSeconds ?? 120) || acceptsAgentTasks !== (snapshot?.acceptsAgentTasks ?? false)
    || generation.reasoningEffort !== (saved?.reasoningEffort ?? "auto") || generation.generationSettings.maxOutputTokens !== (saved?.maxOutputTokens ?? null) || !!apiKey.trim();

  const apply = useCallback((value: Snapshot) => {
    setSnapshot(value);
    setBaseUrl(value.settings?.baseUrl ?? "");
    setModel(value.settings?.model ?? "");
    setApiMode(value.settings?.apiMode ?? "chat_completions");
    setTimeoutSeconds(String(value.settings?.timeoutSeconds ?? 120));
    setAcceptsAgentTasks(value.acceptsAgentTasks);
    setApiKey("");
    applyGenerationSettings(value.settings);
    resetTests();
  }, [resetTests, applyGenerationSettings]);

  useEffect(() => {
    let active = true;
    const read = async () => {
      try { const value = await apiRequest<Snapshot>(taskEndpoint()); if (active) apply(value); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "个人 Agent 暂时无法读取。"); }
      finally { if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => { void apiRequest<Snapshot>(taskEndpoint()).then(value => { if (active) setSnapshot(current => ({ ...value, settings: current?.settings ?? value.settings })); }).catch(() => {}); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [taskEndpoint, apply]);

  const submit = async (action: "save" | "test") => {
    if (pending !== null || loading) return;
    setPending(action); setError(""); setMessage(""); setConfirmClear(false);
    const key = apiKey.trim();
    const settings = { baseUrl: baseUrl.trim(), model: model.trim(), apiMode, timeoutSeconds: Number(timeoutSeconds), ...generation.generationSettings, ...(key ? { apiKey: key } : {}) };
    try {
      if (action === "test") {
        const result = await apiRequest<ModelTestResponse>(`${endpoint}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, testKind }) });
        recordTest(testKind, true, result.message);
      } else {
        const result = await apiRequest<{ settings: Settings; acceptsAgentTasks: boolean }>(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, acceptsAgentTasks }) });
        setSnapshot(current => current ? { ...current, settings: result.settings, acceptsAgentTasks: result.acceptsAgentTasks } : null);
        setBaseUrl(result.settings.baseUrl); setModel(result.settings.model); setApiMode(result.settings.apiMode); setTimeoutSeconds(String(result.settings.timeoutSeconds)); setAcceptsAgentTasks(result.acceptsAgentTasks);
        setApiKey(""); applyGenerationSettings(result.settings); resetTests(); setMessage("个人 Agent 配置已保存。新的个人子任务将使用此配置；项目研究与工作区执行仍使用项目模型设置。");
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : action === "test" ? "此项测试未通过。" : "保存失败，请检查 API 地址、Key 和模型 ID。";
      if (action === "test") recordTest(testKind, false, detail);
      else setError(detail);
    }
    finally { setPending(null); }
  };

  const clear = async () => {
    setPending("clear"); setError(""); setMessage("");
    try {
      const result = await apiRequest<{ settings: null; acceptsAgentTasks: false }>(endpoint, { method: "DELETE" });
      setSnapshot(current => current ? { ...current, ...result } : null);
      resetTests();
      applyGenerationSettings(null);
      setBaseUrl(""); setModel(""); setApiMode("chat_completions"); setTimeoutSeconds("120"); setApiKey(""); setAcceptsAgentTasks(false); setConfirmClear(false); setMessage("个人 Agent 配置已清除，接收权限已关闭。");
    } catch { setError("清除失败，请稍后重试。"); }
    finally { setPending(null); }
  };

  const busy = pending !== null;
  return <details className="panel group mb-5 overflow-hidden" open={mode === "settings"}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-sm font-semibold text-[#365540]">{mode === "settings" ? "个人模型与接收权限" : "个人 Agent 与任务收件箱"}</span><span className="rounded-full bg-[#eef2e7] px-2.5 py-1 text-[10px] text-[#617655]">{loading ? "读取中" : acceptsAgentTasks && snapshot?.settings ? "已开放接收" : snapshot?.settings ? "未开放接收" : "未配置"}</span></span>
      <span className="shrink-0 text-xs text-[#65735d]"><span className="group-open:hidden">展开</span><span className="hidden group-open:inline">收起</span><span className="ml-2 inline-block transition-transform group-open:rotate-180" aria-hidden="true">⌄</span></span>
    </summary>
    <div className="border-t border-[#e3e8db] px-5 pb-5 pt-4 sm:px-6 sm:pb-6" aria-busy={loading || busy}>
      <p className="mb-4 text-xs leading-6 text-[#65735d]">这些参数与个人 API Key 用于分配给你的受限子任务及个人任务对话。项目研究和工作区执行使用项目主页的“模型 API 设置”，不受此处修改影响。</p>
      {!loading && saved && <p aria-label="已保存的个人模型配置" className="mb-4 rounded-lg bg-[#f0f3e9] px-4 py-3 text-xs leading-6 text-[#45633c]">已保存并用于新的个人 Agent 子任务：{generationSettingsSummary(saved)}</p>}
      {!loading && mode === "settings" && unsaved && <p role="status" className="mb-4 rounded-lg border border-[#e8dcc0] bg-[#fff9eb] px-4 py-3 text-xs leading-6 text-[#836b40]">未保存修改。测试使用当前草稿；请点击“保存个人设置”应用到个人 Agent，项目研究与工作区执行配置不会随之改变。</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-[#e8cfc3] bg-[#fff5ed] px-4 py-3 text-xs leading-6 text-[#9d5944]">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg border border-[#d5e2cd] bg-[#f0f5e9] px-4 py-3 text-xs leading-6 text-[#45633c]">{message}</p>}
      {mode === "settings" ? <form onChange={event => { if (!(event.target instanceof HTMLSelectElement && event.target.name === "modelTestKind")) { resetTests(); setError(""); setMessage(""); } }} onSubmit={event => { event.preventDefault(); const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; void submit(button?.value === "test" ? "test" : "save"); }}>
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          <label>API Base URL<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required maxLength={2000} pattern="https://.+" placeholder="https://api.deepseek.com" disabled={busy || loading} autoComplete="off" spellCheck={false} /></label>
          <label>API Key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} required={!snapshot?.settings?.hasApiKey} maxLength={4096} placeholder={snapshot?.settings?.hasApiKey ? "留空以保留已保存的 Key" : "填写个人 Agent API Key"} disabled={busy || loading} autoComplete="off" spellCheck={false} /></label>
          <label>模型 ID<input value={model} onChange={event => setModel(event.target.value)} required maxLength={200} placeholder="deepseek-flash" disabled={busy || loading} autoComplete="off" spellCheck={false} /></label>
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-4"><label>API 协议<select value={apiMode} onChange={event => setApiMode(event.target.value as ApiMode)} disabled={busy || loading}><option value="chat_completions">Chat Completions</option><option value="responses">Responses API</option></select></label><label>超时（秒）<input type="number" value={timeoutSeconds} onChange={event => setTimeoutSeconds(event.target.value)} required min={10} max={300} step={1} disabled={busy || loading} /></label></div>
        </div>
        <ModelGenerationSettingsFields id={`personal-model-${projectId}`} baseUrl={baseUrl} reasoningEffort={generation.reasoningEffort} onReasoningChange={generation.setReasoningEffort} customOutput={generation.customOutput} onCustomOutputChange={generation.setCustomOutput} outputTokens={generation.outputTokens} onOutputTokensChange={generation.setOutputTokens} disabled={busy || loading} />
        <label className="mt-5 flex items-start gap-3 rounded-lg border border-[#e3e8db] px-4 py-3 text-xs leading-5 text-[#344631]"><input type="checkbox" checked={acceptsAgentTasks} onChange={event => setAcceptsAgentTasks(event.target.checked)} disabled={busy || loading} className="mt-1 accent-[#45633c]" /><span>允许本项目的顶层 Agent 向我的个人 Agent 派发子任务</span></label>
        <div className="mt-5 flex flex-wrap items-center gap-3"><button type="submit" value="save" className="primary text-sm" disabled={busy || loading}>{pending === "save" ? "正在保存…" : "保存个人设置"}</button><p className="text-[11px] leading-5 text-[#65735d]">测试不会自动保存，请点击“保存个人设置”应用配置。</p></div>
        <ModelCapabilityTests id={`personal-model-${projectId}`} testKind={testKind} onTestKindChange={setTestKind} results={results} pending={pending === "test"} disabled={busy || loading} baseUrl={baseUrl} apiMode={apiMode} />
        {snapshot?.settings && <div className="mt-5 border-t border-[#e3e8db] pt-4">{confirmClear ? <div className="flex flex-wrap items-center gap-3"><p className="basis-full text-xs leading-6 text-[#836b40]">清除后，此项目的 Agent 将不再向你派发任务。确定清除吗？</p><button type="button" className="secondary text-[#9d5944]" disabled={busy || loading} onClick={() => void clear()}>{pending === "clear" ? "正在清除…" : "确认清除"}</button><button type="button" className="secondary" disabled={busy || loading} onClick={() => setConfirmClear(false)}>取消</button></div> : <button type="button" className="text-xs text-[#7e7861] underline underline-offset-4" disabled={busy || loading} onClick={() => setConfirmClear(true)}>清除个人配置</button>}</div>}
      </form> : <a className="secondary inline-block" href={`/profile?tab=agent&project=${encodeURIComponent(projectId)}`}>在个人中心管理 Agent 设置 ↗</a>}
      {mode === "inbox" && <section aria-label="个人 Agent 任务收件箱" className="mt-6 border-t border-[#e3e8db] pt-5">
        <div className="mb-3 flex items-baseline justify-between gap-3"><h3 className="text-sm font-semibold text-[#344631]">我的任务</h3><span className="text-xs text-[#65735d]">{snapshot?.tasks.length ?? 0} 项</span></div>
        {loading ? <p className="text-xs text-[#65735d]">正在读取任务…</p> : snapshot?.tasks.length ? <ul className="divide-y divide-[#e3e8db]">{snapshot.tasks.map(task => <PersonalTask key={task.id} projectId={projectId} task={task} refresh={async () => { const value = await apiRequest<Snapshot>(taskEndpoint()); setSnapshot(value); }} />)}</ul> : <p className="text-xs leading-6 text-[#65735d]">目前没有分配给你的任务。</p>}
      </section>}
    </div>
  </details>;
}
