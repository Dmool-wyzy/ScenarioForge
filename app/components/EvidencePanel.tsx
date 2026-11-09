"use client";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import type { EvidenceCard } from "@/lib/types";
import FavoriteButton from "./FavoriteButton";
import KnowledgeStatus, { type Knowledge } from "./KnowledgeStatus";
import RetrievalPanel from "./RetrievalPanel";

type EvidenceList = { total: number; pageSize: number; results: { evidenceId: string; content: string; source: { title: string; type: string; current: boolean } }[] };
export default function EvidencePanel({ projectId, packageId, evidenceCards, revision, onSelect }: {
  projectId: string; packageId: string; evidenceCards: EvidenceCard[]; revision: number; onSelect: (id: string) => void;
}) {
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null), [evidence, setEvidence] = useState<EvidenceList | null>(null);
  const [sourceType, setSourceType] = useState(""), [page, setPage] = useState(1), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [sharingId, setSharingId] = useState(""), [sharedIds, setSharedIds] = useState<string[]>([]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [status, rows] = await Promise.all([apiRequest<Knowledge>("/api/research/" + packageId + "/knowledge", { signal }), apiRequest<EvidenceList>("/api/research/" + packageId + "/evidence?page=" + page + "&sourceType=" + sourceType, { signal })]);
    setKnowledge(status); setEvidence(rows);
  }, [packageId, page, sourceType]);
  useEffect(() => {
    const abort = new AbortController();
    queueMicrotask(() => { if (!abort.signal.aborted) void refresh(abort.signal).catch(error => { if (!abort.signal.aborted) setError(error.message); }); });
    return () => abort.abort();
  }, [refresh, revision]);
  const share = async (card: EvidenceCard) => {
    if (!card.id) return;
    setSharingId(card.id); setError("");
    try {
      const result = await apiRequest<{ created: boolean }>("/api/projects/" + projectId + "/knowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId, evidenceId: card.id }) });
      setSharedIds(ids => ids.includes(card.id!) ? ids : [...ids, card.id!]);
      setError(result.created ? "证据已加入团队共享资料。" : "这条证据已在团队共享资料中。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法共享这条证据。"); }
    finally { setSharingId(""); }
  };
  return <details className="border-y border-[#dce1d9] px-6 py-4">
    <summary className="cursor-pointer text-sm font-semibold">证据与检索 · {knowledge?.chunkCount ?? 0} 个分块</summary>
    <div className="mt-4">
      <KnowledgeStatus knowledge={knowledge} busy={busy} onRebuild={async () => { setBusy(true); setError(""); try { await apiRequest("/api/research/" + packageId + "/knowledge/rebuild", { method: "POST" }); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "重建失败。"); } finally { setBusy(false); } }} />
      {error && <p role="status" className="mt-2 text-sm text-[#7b6544]">{error}</p>}
      {evidenceCards.length > 0 && <div className="mt-5 border-t border-[#dce1d9] pt-4"><h3 className="text-sm font-semibold">加入团队共享资料</h3><p className="muted mt-1 text-xs">只共享你选择的证据；可信状态和原来源会一并保留。</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{evidenceCards.map(card => <article id={`saved-evidence-${card.id}`} key={card.id ?? card.code} className="rounded border border-[#dce1d9] p-3"><p className="text-xs font-medium">{card.code} · {card.confidence} / {card.status}</p><p className="mt-1 text-xs leading-5">{card.claim.slice(0, 180)}</p><button type="button" className="secondary mt-2 text-xs" disabled={!card.id || sharingId === card.id || sharedIds.includes(card.id ?? "")} onClick={() => void share(card)}>{sharedIds.includes(card.id ?? "") ? "已加入共享资料" : sharingId === card.id ? "正在加入…" : "加入共享资料"}</button>{card.id && <FavoriteButton kind="evidence" targetId={card.id} />}</article>)}</div></div>}
      <label className="mt-5 block">来源类型<select aria-label="证据来源类型" value={sourceType} onChange={event => { setSourceType(event.target.value); setPage(1); }}><option value="">全部来源</option><option value="web">网页</option><option value="upload">上传资料与目标</option><option value="workspace">工作区文档</option><option value="clarification">澄清回答</option></select></label>
      <div className="mt-3 grid max-h-80 gap-2 overflow-auto sm:grid-cols-2">{evidence?.results.map(row => <button key={row.evidenceId} onClick={() => onSelect(row.evidenceId)} className="rounded border border-[#dce1d9] p-3 text-left text-xs"><strong>{row.evidenceId} · {row.source.title}</strong><span className="muted">{row.source.current ? "" : " · 历史版本"}</span><p className="muted mt-2 leading-6">{row.content}</p></button>)}</div>
      {evidence?.total === 0 && <p className="muted mt-3 text-sm">暂无证据分块。配置 Embedding 后可为现有资料建立索引。</p>}
      <div className="mt-3 flex items-center gap-3 text-xs"><button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} 页 · 共 {evidence?.total ?? 0} 条</span><button disabled={!evidence || page * evidence.pageSize >= evidence.total} onClick={() => setPage(page + 1)}>下一页</button></div>
      <RetrievalPanel key={packageId} packageId={packageId} sourceType={sourceType} onSelect={onSelect} />
    </div>
  </details>;
}
