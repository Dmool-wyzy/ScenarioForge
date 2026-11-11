"use client";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import ResearchSubmitMode, { type ResearchMode } from "./ResearchSubmitMode";

type SharedKnowledge = { id: string; title: string; claim: string; confidence: string; status: string; originPackageTitle: string; originEvidenceCode: string };

const examples = ["我想做一个帮助东京留学生找合租室友的应用。预算低，团队 3 人，两周内完成课程演示。", "我想调研安全帽检测的常用数据集、模型和评估指标，为计算机视觉课程项目做准备。", "我想为东京的中国留学生组织一次中秋交流活动，预算有限，预计 30 人参加，需要活动流程和分工。"];

export default function ResearchForm({ projectId, onSubmit, loading, disabled, mode, onModeChange }: { projectId: string; onSubmit: (form: FormData) => Promise<void>; loading: boolean; disabled: boolean; mode: ResearchMode; onModeChange: (mode: ResearchMode) => void }) {
  const [goal, setGoal] = useState(""); const [names, setNames] = useState<string[]>([]); const [error, setError] = useState(""); const inputRef = useRef<HTMLInputElement>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState(""), [knowledge, setKnowledge] = useState<SharedKnowledge[]>([]), [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false), [knowledgeError, setKnowledgeError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setKnowledgeLoading(true); setKnowledgeError("");
      const params = new URLSearchParams({ q: knowledgeQuery });
      void apiRequest<{ results: SharedKnowledge[] }>("/api/projects/" + projectId + "/knowledge?" + params, { signal: abort.signal })
        .then(result => setKnowledge(result.results))
        .catch(cause => { if (!abort.signal.aborted) setKnowledgeError(cause instanceof Error ? cause.message : "无法搜索项目共享资料。"); })
        .finally(() => { if (!abort.signal.aborted) setKnowledgeLoading(false); });
    }, knowledgeQuery ? 250 : 0);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [projectId, knowledgeQuery]);
  return <form className="space-y-5" onSubmit={async (event) => {
    event.preventDefault(); setError("");
    const data = new FormData(event.currentTarget); const files = inputRef.current?.files;
    if (files && (files.length > 5 || Array.from(files).some((f) => f.size > 5 * 1024 * 1024 || !/\.(md|txt|pdf|docx)$/i.test(f.name)))) { setError("请上传最多 5 个 .md、.txt、.pdf 或 .docx 文件，每个不超过 5 MB。"); return; }
    const constraints = { deadline: data.get("deadline"), teamSize: data.get("teamSize") ? Number(data.get("teamSize")) : undefined, budget: data.get("budget"), techPreference: data.get("techPreference") };
    const payload = new FormData(); payload.set("goal", goal); payload.set("constraints", JSON.stringify(constraints));
    payload.set("mode", mode);
    payload.set("sharedKnowledgeIds", JSON.stringify(selectedKnowledge));
    for (const file of Array.from(files ?? [])) payload.append("files", file);
    await onSubmit(payload);
  }}>
    <ResearchSubmitMode mode={mode} onChange={onModeChange} disabled={loading || disabled} />
    <label>你想完成什么？<textarea name="goal" value={goal} onChange={(e) => setGoal(e.target.value)} required minLength={1} maxLength={5000} rows={5} placeholder={mode === "documents" ? "描述目标、需要生成的文件和验收标准……" : "讨论想法、提问，或明确要求联网调研……"} disabled={loading} /></label>
    <div className="flex flex-wrap gap-2">{["软件项目", "研究项目", "活动策划"].map((label, i) => <button type="button" className="rounded-full border border-[#dce1d9] px-3 py-1 text-xs text-[#527060]" key={label} disabled={loading} onClick={() => setGoal(examples[i])}>{label}示例 ↗</button>)}</div>
    <details><summary className="cursor-pointer text-sm font-medium">约束条件 <span className="muted font-normal">（选填）</span></summary><div className="mt-4 grid grid-cols-2 gap-3"><label>截止时间<input name="deadline" maxLength={200} placeholder="例如：两周内" /></label><label>团队人数<input name="teamSize" type="number" min={1} max={1000} placeholder="例如：3" /></label><label>预算<input name="budget" maxLength={200} placeholder="例如：低预算" /></label><label>技术偏好<input name="techPreference" maxLength={500} placeholder="例如：Next.js" /></label></div></details>
    <div className="rounded-lg border border-dashed border-[#bfcfc3] bg-[#f7f9f4] p-4"><label className="cursor-pointer">参考资料 <span className="muted font-normal">（选填）</span><input ref={inputRef} type="file" name="files" multiple accept=".md,.txt,.pdf,.docx" onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))} className="mt-3 text-xs" /></label><p className="muted mt-2 text-xs leading-6">MD / TXT / PDF / DOCX · 最多 5 个 · 每个 5 MB</p>{names.length > 0 && <p className="mt-2 break-all text-xs">{names.join("、")}</p>}</div>
    <details className="rounded-lg border border-[#dce1d9] p-4"><summary className="cursor-pointer text-sm font-medium">复用团队共享资料 <span className="muted font-normal">（最多 3 条）</span></summary><div className="mt-3"><label>搜索资料<input value={knowledgeQuery} onChange={event => setKnowledgeQuery(event.target.value)} maxLength={100} placeholder="关键词搜索同一项目的历史证据" /></label><p className="muted mt-1 text-xs">关键词匹配，不调用 Embedding。选中的资料会随本次研究保存，并保留原可信状态。</p>{knowledgeError && <p role="alert" className="mt-2 text-xs text-red-700">{knowledgeError}</p>}<div className="mt-2 grid max-h-64 gap-2 overflow-auto">{knowledge.map(item => {
      const selected = selectedKnowledge.includes(item.id);
      return <label key={item.id} className="flex items-start gap-2 rounded border border-[#e1e6dc] p-3 text-xs"><input type="checkbox" checked={selected} disabled={!selected && selectedKnowledge.length >= 3} onChange={event => setSelectedKnowledge(ids => event.target.checked ? ids.length < 3 ? [...ids, item.id] : ids : ids.filter(id => id !== item.id))} /><span className="min-w-0"><strong className="block break-words">{item.title}</strong><span className="muted mt-1 block">{item.originPackageTitle} · {item.originEvidenceCode} · {item.confidence} / {item.status}</span><span className="mt-1 block leading-5">{item.claim.slice(0, 220)}</span></span></label>;
    })}{knowledgeLoading && <p className="muted py-2 text-xs">正在搜索…</p>}{!knowledgeLoading && !knowledge.length && !knowledgeError && <p className="muted py-2 text-xs">没有匹配的共享资料。</p>}</div></div></details>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button className="primary w-full" disabled={loading || disabled || !goal.trim()}>{loading ? "正在提交…" : disabled ? "Agent 正在处理中" : mode === "documents" ? "预览文档清单" : "发送 →"}</button>
  </form>;
}
