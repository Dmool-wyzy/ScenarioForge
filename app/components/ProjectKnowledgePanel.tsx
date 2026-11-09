"use client";
import { useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";

type KnowledgeItem = {
  id: string; title: string; question: string; claim: string; confidence: string; status: string;
  sources: { title: string; url: string; snippet: string; accessedAt: string }[];
  originPackageTitle: string; originEvidenceCode: string; createdAt: string; archivedAt: string | null; canManage: boolean;
};

export default function ProjectKnowledgePanel({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState(""), [items, setItems] = useState<KnowledgeItem[]>([]), [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const load = async (value = query, signal?: AbortSignal) => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ q: value, includeArchived: "true" });
      const result = await apiRequest<{ total: number; results: KnowledgeItem[] }>("/api/projects/" + projectId + "/knowledge?" + params, { signal });
      setItems(result.results); setTotal(result.total);
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "无法读取项目共享资料。"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => {
    const abort = new AbortController();
    void apiRequest<{ total: number; results: KnowledgeItem[] }>("/api/projects/" + projectId + "/knowledge?includeArchived=true", { signal: abort.signal })
      .then(result => { setItems(result.results); setTotal(result.total); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取项目共享资料。"); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [projectId]);
  const setArchived = async (item: KnowledgeItem, archived: boolean) => {
    setBusy(true); setError("");
    try {
      await apiRequest("/api/projects/" + projectId + "/knowledge/" + item.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新资料状态失败。"); setBusy(false); }
  };
  return <details id="project-knowledge" className="panel mb-5 px-5 py-4 sf-action-target">
    <summary className="cursor-pointer text-sm font-semibold">团队共享资料 · {total} 条</summary>
    <div className="mt-4">
      <p className="muted text-xs leading-5">从研究证据中手动加入的资料。关键词检索不使用 Embedding；Mock 搜索证据不会被接纳。</p>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void load(query); }}>
        <label className="min-w-[220px] flex-1">搜索共享资料<input value={query} onChange={event => setQuery(event.target.value)} maxLength={100} placeholder="输入主题、来源或关键词" /></label>
        <button className="secondary self-end text-xs" disabled={busy}>{busy ? "读取中…" : "搜索"}</button>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-3 divide-y divide-[#e5e9e0]">
        {items.map(item => <article key={item.id} className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{item.title}</h3><p className="muted mt-1 text-xs">来源研究：{item.originPackageTitle} · {item.originEvidenceCode} · {item.confidence} / {item.status}{item.archivedAt ? " · 已归档" : ""}</p><p className="mt-2 text-xs leading-5">{item.claim}</p><p className="muted mt-1 text-xs">研究问题：{item.question}</p>{item.sources.slice(0, 3).map((source, index) => <p key={source.url + index} className="muted mt-1 break-all text-xs">{source.title} · {source.url}</p>)}</div>
            {item.canManage && <button type="button" className="secondary shrink-0 text-xs" disabled={busy} onClick={() => void setArchived(item, !item.archivedAt)}>{item.archivedAt ? "恢复" : "归档"}</button>}
          </div>
        </article>)}
        {!items.length && <p className="muted py-4 text-sm">{query ? "没有匹配的共享资料。" : "还没有共享资料。可在研究证据面板中选择资料加入。"}</p>}
      </div>
    </div>
  </details>;
}
