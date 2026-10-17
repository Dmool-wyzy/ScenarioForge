"use client";

import { useState } from "react";
import { useResearch } from "@/hooks/useResearch";
import type { WorkspaceFilename } from "@/lib/types";
import ResearchForm from "./components/ResearchForm";
import ResearchProgress from "./components/ResearchProgress";
import FileTabs from "./components/FileTabs";
import FilePlan from "./components/FilePlan";
import MarkdownViewer from "./components/MarkdownViewer";
import DownloadButtons from "./components/DownloadButtons";
import ClarificationCard from "./components/ClarificationCard";
import MarkdownEditor from "./components/MarkdownEditor";
import EvidencePanel from "./components/EvidencePanel";
import EvidenceDetail from "./components/EvidenceDetail";

export default function Home() {
  const research = useResearch();
  const [selected, setSelected] = useState<WorkspaceFilename>("README.md");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const snapshot = research.snapshot;
  const files = snapshot?.files ?? [];
  const filePlan = snapshot?.filePlan ?? [];
  const current = files.find((f) => f.filename === selected);
  const busy = !!snapshot && ["created", "researching", "waiting_for_user", "waiting_for_edit"].includes(snapshot.status);
  return <main className="mx-auto max-w-[1600px] px-5 py-8 lg:px-10">
    <header className="mb-10 flex items-center justify-between border-b border-[#dce1d9] pb-6"><div className="flex items-center gap-3"><span className="rounded-lg bg-[#1c6555] px-3 py-2 text-xl font-bold text-white">S</span><span className="text-xl font-bold tracking-tight">ScenarioForge</span></div><span className="muted text-sm">先研究，再创作</span></header>
    <div className="mb-8"><p className="muted mb-3 text-xs tracking-[.2em]">从想法到行动</p><h1 className="text-3xl font-semibold tracking-tight lg:text-4xl">让每一个计划，都有据可依。</h1><p className="muted mt-3">提出目标，整理证据，构建你的项目工作区。</p></div>
    {research.error && <div role="alert" className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{research.error}</p><button aria-label="关闭错误提示" onClick={() => research.setError("")}>×</button></div>}
    <div className="grid items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
      <section className="panel p-6"><h2 className="mb-5 text-lg font-semibold">研究与对话</h2><ResearchForm onSubmit={research.create} loading={research.creating} disabled={busy || editing} /><ResearchProgress events={snapshot?.events ?? []} status={snapshot?.status} connection={research.connection} />
        {snapshot?.clarifications.map((question) => <ClarificationCard key={question.id} question={question} packageId={snapshot.id} onAnswered={research.refresh} />)}
        {snapshot?.summary && <section className="mt-6 border-t border-[#e1e6dc] pt-5"><h3 className="mb-3 text-sm font-semibold">Agent 总结</h3><div className="text-sm"><MarkdownViewer content={snapshot.summary} /></div></section>}
        {snapshot && <form className="mt-6 space-y-3 border-t border-[#e1e6dc] pt-5" onSubmit={async (e) => { e.preventDefault(); setSending(true); try { await research.sendMessage(message); setMessage(""); } catch (error) { research.setError(error instanceof Error ? error.message : "发送失败。"); } finally { setSending(false); } }}><label>继续与 Agent 对话<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={5000} placeholder="例如：细化阶段二的任务和验收标准" /></label><button className="secondary" disabled={sending || !message.trim() || busy}>{sending ? "正在发送…" : "发送并继续研究"}</button></form>}
      </section>
      <section className="panel min-h-[600px] min-w-0 overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5"><div><h2 className="text-lg font-semibold">项目工作区</h2><p className="muted mt-1 text-xs">{snapshot ? `${snapshot.title} · ${files.length} 份已生成${filePlan.length ? ` / ${filePlan.length} 份计划` : ""}` : "先展示文件计划，再按场景生成 Markdown 文档"}</p></div><DownloadButtons packageId={research.packageId} filename={selected} hasFiles={files.length > 0} hasCurrent={!!current} /></div>
        <FilePlan items={filePlan} files={files} />
        {snapshot && <EvidencePanel key={snapshot.id} packageId={snapshot.id} revision={snapshot.events.at(-1)?.sequence ?? 0} onSelect={setEvidenceId} />}
        <FileTabs filePlan={filePlan} files={files} selected={selected} onSelect={setSelected} disabled={editing} />
        {current && snapshot ? <div className="p-6 lg:p-8"><div className="muted mb-6 flex items-center justify-between border-b border-[#e9ece4] pb-3 text-xs"><span>版本 {current.version} · {current.updatedBy === "user" ? "你更新了此文件" : "Agent 生成"}</span><span>{current.lockedBy ? "正在编辑" : "已保存"}</span></div><MarkdownEditor key={`${snapshot.id}:${selected}`} file={current} packageId={snapshot.id} onSaved={research.refresh} onEditingChange={setEditing} />{!editing && <MarkdownViewer content={current.content} onEvidenceClick={setEvidenceId} />}</div> : <div className="flex min-h-[430px] flex-col items-center justify-center px-8 text-center"><span className="mb-5 text-4xl text-[#9eb6a9]">◇</span><h3 className="text-lg font-medium">{snapshot ? "证据正在成为你的计划" : "你的下一个项目，从这里开始"}</h3><p className="muted mt-3 max-w-md text-sm leading-7">{snapshot ? `${selected} 尚未生成。你可以在左侧查看研究进度。` : "输入目标后，系统会先研究问题、收集来源，再根据场景选择并生成有用的文档。"}</p></div>}
      </section>
    </div>
    <footer className="muted mt-8 text-center text-xs">事实有来源 · 推断有标记 · 决策由你确认</footer>
    {snapshot && evidenceId && <EvidenceDetail key={`${snapshot.id}:${evidenceId}`} packageId={snapshot.id} evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />}
  </main>;
}
