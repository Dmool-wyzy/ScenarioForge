"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";

type ApiMode = "responses" | "chat_completions";
type Settings = { baseUrl: string; model: string; apiMode: ApiMode; timeoutSeconds: number; deepseekSearchEnabled: boolean; hasApiKey: boolean };
type SettingsResponse = { settings: Settings | null; canEdit: boolean };

function isDeepSeekBaseUrl(value: string) {
  try { return new URL(value).hostname === "api.deepseek.com"; } catch { return false; }
}

export default function ModelSettings({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiMode, setApiMode] = useState<ApiMode>("chat_completions");
  const [timeoutSeconds, setTimeoutSeconds] = useState("120");
  const [deepseekSearchEnabled, setDeepseekSearchEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"save" | "test" | "clear" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const endpoint = `/api/projects/${projectId}/model`;
  const editable = isOwner && canEdit;
  const busy = pending !== null;

  const applySettings = useCallback((result: SettingsResponse) => {
    setSettings(result.settings);
    setCanEdit(result.canEdit);
    setBaseUrl(result.settings?.baseUrl ?? "");
    setModel(result.settings?.model ?? "");
    setApiMode(result.settings?.apiMode ?? "chat_completions");
    setTimeoutSeconds(String(result.settings?.timeoutSeconds ?? 120));
    setDeepseekSearchEnabled(result.settings?.deepseekSearchEnabled ?? false);
    setApiKey("");
  }, []);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void apiRequest<SettingsResponse>(endpoint, { signal: abort.signal }).then(result => {
      if (active) applySettings(result);
    }).catch(() => {
      if (active) { setLoadFailed(true); setError("暂时无法读取模型 API 设置，请稍后重试。"); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [endpoint, reload, applySettings]);

  const submit = async (action: "save" | "test") => {
    if (!editable || busy) return;
    setPending(action); setError(""); setMessage(""); setConfirmClear(false);
    const key = apiKey.trim();
    const draft = { baseUrl: baseUrl.trim(), model: model.trim(), apiMode, timeoutSeconds: Number(timeoutSeconds), deepseekSearchEnabled, ...(key ? { apiKey: key } : {}) };
    try {
      if (action === "save") {
        const result = await apiRequest<SettingsResponse>(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        applySettings(result);
        setMessage("项目模型配置已保存。成员后续发起的研究将使用此配置。");
      } else {
        await apiRequest<{ ok: true; message: string }>(`${endpoint}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        setMessage("连接测试成功。测试不会自动保存配置，请点击“保存设置”应用修改。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === "test" ? "连接测试未通过。请检查 API 地址、凭据、模型权限和协议，或稍后重试。" : "保存失败。请检查 HTTPS 地址、API Key、模型 ID 及其他字段，或稍后重试。");
    } finally { setPending(null); }
  };

  const clearSettings = async () => {
    if (!editable || busy || !confirmClear) return;
    setPending("clear"); setError(""); setMessage("");
    try {
      const result = await apiRequest<SettingsResponse>(endpoint, { method: "DELETE" });
      applySettings(result); setConfirmClear(false);
      setMessage("已清除本项目的模型 API 配置。");
    } catch { setError("清除失败，请稍后重试。当前配置未在此页面中更改。"); }
    finally { setPending(null); }
  };

  return <details className="panel group mb-5 overflow-hidden">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-sm font-semibold text-[#365540]">模型 API 设置</span><span className="rounded-full bg-[#eef2e7] px-2.5 py-1 text-[10px] text-[#617655]">{loading ? "读取中" : settings?.deepseekSearchEnabled ? "DeepSeek 搜索已启用" : settings?.hasApiKey ? "已配置" : loadFailed ? "暂不可用" : "未配置"}</span></span>
      <span className="shrink-0 text-xs text-[#65735d]"><span className="group-open:hidden">展开</span><span className="hidden group-open:inline">收起</span><span className="ml-2 inline-block transition-transform group-open:rotate-180" aria-hidden="true">⌄</span></span>
    </summary>
    <div className="border-t border-[#e3e8db] px-5 pb-5 pt-4 sm:px-6 sm:pb-6" aria-busy={loading || busy}>
      <p className="mb-5 text-xs leading-6 text-[#65735d]">项目成员发起的研究将使用此配置。保存后从下一轮研究生效，进行中的研究保持原配置。API Key 仅供服务端调用，不向成员展示。</p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-[#e8cfc3] bg-[#fff5ed] px-4 py-3 text-xs leading-6 text-[#9d5944]">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg border border-[#d5e2cd] bg-[#f0f5e9] px-4 py-3 text-xs leading-6 text-[#45633c]">{message}</p>}
      {loading ? <p role="status" className="text-xs text-[#65735d]">正在读取项目模型设置…</p> : loadFailed ? <button type="button" className="secondary" onClick={() => { setLoading(true); setLoadFailed(false); setError(""); setMessage(""); setReload(value => value + 1); }}>重新读取</button> : editable ? <form onSubmit={event => {
        event.preventDefault();
        const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void submit(button?.value === "test" ? "test" : "save");
      }}>
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          <label htmlFor={`model-base-url-${projectId}`}>API Base URL<input id={`model-base-url-${projectId}`} name="modelBaseUrl" type="url" value={baseUrl} onChange={event => { setBaseUrl(event.target.value); if (event.target.value.startsWith("https://") && !isDeepSeekBaseUrl(event.target.value)) setDeepseekSearchEnabled(false); }} required maxLength={2000} pattern="https://.+" title="请输入 HTTPS API 基础地址" placeholder="填写 HTTPS API 基础地址" disabled={busy} autoComplete="off" spellCheck={false} /><span className="mt-2 block text-[11px] font-normal leading-5 text-[#65735d]">填写服务商提供的基础地址，无需添加具体接口路径。</span></label>
          <label htmlFor={`model-api-key-${projectId}`}>API Key <span className="font-normal text-[#65735d]">{settings?.hasApiKey ? "· 已保存" : "· 尚未保存"}</span><input id={`model-api-key-${projectId}`} name="projectApiCredential" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} required={!settings?.hasApiKey} maxLength={4096} placeholder={settings?.hasApiKey ? "留空以保留已保存的 API Key" : "填写项目专用 API Key"} disabled={busy} autoComplete="off" spellCheck={false} /><span className="mt-2 block text-[11px] font-normal leading-5 text-[#65735d]">已保存的凭据不会回显；更换时填写新 Key 并保存。</span></label>
          <label htmlFor={`model-id-${projectId}`}>模型 ID<input id={`model-id-${projectId}`} name="projectModel" value={model} onChange={event => setModel(event.target.value)} required maxLength={200} placeholder="填写你有权限使用的模型 ID" disabled={busy} autoComplete="off" spellCheck={false} /></label>
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-4"><label htmlFor={`model-api-mode-${projectId}`}>API 协议<select id={`model-api-mode-${projectId}`} value={apiMode} onChange={event => setApiMode(event.target.value as ApiMode)} disabled={busy}><option value="chat_completions">Chat Completions</option><option value="responses">Responses API</option></select></label><label htmlFor={`model-timeout-${projectId}`}>超时（秒）<input id={`model-timeout-${projectId}`} type="number" value={timeoutSeconds} onChange={event => setTimeoutSeconds(event.target.value)} required min={10} max={300} step={1} disabled={busy} /></label></div>
        </div>
        {isDeepSeekBaseUrl(baseUrl) && <label className="mt-5 flex items-start gap-3 rounded-lg border border-[#e3e8db] px-4 py-3 text-xs leading-5 text-[#344631]"><input type="checkbox" checked={deepseekSearchEnabled} onChange={event => setDeepseekSearchEnabled(event.target.checked)} disabled={busy} className="mt-1 accent-[#45633c]" /><span><span className="font-semibold">启用 DeepSeek 联网搜索</span><span className="mt-1 block text-[#65735d]">只用于本项目研究，查询会发送到 DeepSeek Search。每次成功且有结果的请求 US$0.00075；每个研究包最多 12 次搜索调用、每次最多 3 个查询，最坏约 US$0.027。空结果和失败不收费；不会调用 Fetch。</span></span></label>}
        <div className="mt-6 flex flex-wrap items-center gap-3"><button type="submit" name="action" value="save" className="primary text-sm" disabled={busy}>{pending === "save" ? "正在保存…" : "保存设置"}</button><button type="submit" name="action" value="test" className="secondary" disabled={busy}>{pending === "test" ? "正在测试连接…" : "测试连接"}</button><p className="basis-full text-[11px] leading-5 text-[#65735d] sm:basis-auto">连接测试会发送一次最小模型请求，可能产生少量费用。</p></div>
        {settings && <div className="mt-5 border-t border-[#e3e8db] pt-4">{confirmClear ? <div className="flex flex-wrap items-center gap-3"><p className="basis-full text-xs leading-6 text-[#836b40]">清除后，本项目将不再使用当前 API 配置。确定要清除吗？</p><button type="button" className="secondary text-[#9d5944]" disabled={busy} onClick={() => void clearSettings()}>{pending === "clear" ? "正在清除…" : "确认清除"}</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button></div> : <button type="button" className="text-xs text-[#7e7861] underline underline-offset-4" disabled={busy} onClick={() => { setConfirmClear(true); setError(""); setMessage(""); }}>清除项目配置</button>}</div>}
      </form> : <div>
        <p className="mb-4 rounded-lg bg-[#f0f3e9] px-4 py-3 text-xs leading-6 text-[#5d7150]">仅项目创建者可以保存、测试或清除模型设置。需要调整时，请联系项目创建者。</p>
        {settings ? <dl className="grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2"><div><dt className="text-[#65735d]">API Base URL</dt><dd className="mt-1.5 break-all leading-6 text-[#344631]">{settings.baseUrl}</dd></div><div><dt className="text-[#65735d]">模型 ID</dt><dd className="mt-1.5 break-all leading-6 text-[#344631]">{settings.model}</dd></div><div><dt className="text-[#65735d]">API 协议</dt><dd className="mt-1.5 text-[#344631]">{settings.apiMode === "responses" ? "Responses API" : "Chat Completions"}</dd></div><div><dt className="text-[#65735d]">超时</dt><dd className="mt-1.5 text-[#344631]">{settings.timeoutSeconds} 秒</dd></div><div><dt className="text-[#65735d]">API Key</dt><dd className="mt-1.5 text-[#344631]">{settings.hasApiKey ? "已保存，不可查看" : "未配置"}</dd></div><div><dt className="text-[#65735d]">DeepSeek 联网搜索</dt><dd className="mt-1.5 text-[#344631]">{settings.deepseekSearchEnabled ? "已启用" : "未启用"}</dd></div></dl> : <p className="text-xs leading-6 text-[#65735d]">此项目尚未保存模型 API 配置。</p>}
      </div>}
    </div>
  </details>;
}
