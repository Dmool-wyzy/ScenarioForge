"use client";
import { useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
type Detail = { evidenceId: string; content: string; chunkIndex: number; metadata: Record<string, unknown>; source: { type: string; title: string; url: string | null; fetchedAt: string; revision: number; current: boolean }; citations: { documentName: string; fileVersion: number; section: string }[] };
export default function EvidenceDetail({ packageId, evidenceId, onClose }: { packageId: string; evidenceId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void apiRequest<Detail>(`/api/research/${packageId}/evidence/${evidenceId}`, { signal: abort.signal }).then(setDetail).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [packageId, evidenceId]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" onClick={onClose}><section role="dialog" aria-modal="true" aria-label="证据详情" className="panel max-h-[85vh] w-full max-w-3xl overflow-auto p-6" onClick={event => event.stopPropagation()}><div className="flex justify-between gap-4"><h3 className="font-semibold">{evidenceId} · 证据详情</h3><button onClick={onClose} aria-label="关闭证据详情">关闭</button></div>{error && <p role="alert">{error}</p>}{detail ? <><p className="my-3 font-medium">{detail.source.title}</p><p className="muted text-xs">{detail.source.type} · 分块 {detail.chunkIndex} · 来源版本 {detail.source.revision} · {detail.source.current ? "当前版本" : "历史版本"} · {new Date(detail.source.fetchedAt).toLocaleString()}</p>{detail.source.url && /^https?:\/\//i.test(detail.source.url) && <a className="my-3 block break-all text-sm underline" href={detail.source.url} target="_blank" rel="noopener noreferrer">{detail.source.url}</a>}<p className="muted my-3 text-xs">资料性质：{String(detail.metadata.trust ?? "待核实")} {detail.metadata.question ? `· 研究问题：${String(detail.metadata.question)}` : ""}</p><pre className="my-4 whitespace-pre-wrap break-words rounded border border-[#cfddd3] bg-[#f5faf5] p-4 text-sm leading-7">{detail.content}</pre><p className="muted text-xs">引用此证据：{detail.citations.map(row => `${row.documentName} v${row.fileVersion} ${row.section}`).join("；") || "暂无文档引用"}</p></> : !error && <p className="my-4">正在读取证据…</p>}</section></div>;
}
