"use client";

import { useState } from "react";
import { useResearch } from "@/hooks/useResearch";
import type { WorkspaceFilename } from "@/lib/types";
import FavoriteButton from "./FavoriteButton";
import ResearchForm from "./ResearchForm";
import ResearchProgress from "./ResearchProgress";
import FileTabs from "./FileTabs";
import FilePlan from "./FilePlan";
import MarkdownViewer from "./MarkdownViewer";
import DownloadButtons from "./DownloadButtons";
import ClarificationCard from "./ClarificationCard";
import MarkdownEditor from "./MarkdownEditor";
import EvidencePanel from "./EvidencePanel";
import EvidenceDetail from "./EvidenceDetail";

export default function Workspace({ projectId, projectName, initialPackageId }: { projectId: string; projectName: string; initialPackageId?: string | null }) {
  const research = useResearch(projectId, initialPackageId);
  const [selected, setSelected] = useState<WorkspaceFilename>(() => typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("file") || "README.md" : "README.md");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const snapshot = research.snapshot;
  const files = snapshot?.files ?? [];
  const filePlan = snapshot?.filePlan ?? [];
  const current = files.find((f) => f.filename === selected);
  const busy = !!snapshot && ["queued", "running"].includes(snapshot.taskState);
  const conversation = snapshot?.events.filter((event) => event.type === "user_message" || event.type === "assistant_message") ?? [];
  const hasWorkspace = filePlan.length > 0 || files.length > 0;
  return <section aria-label={`${projectName}的研究工作区`}>
    {research.error && <div role="alert" className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{research.error}</p><button aria-label="关闭错误提示" onClick={() => research.setError("")}>×</button></div>}
    <div className="grid items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
      <section className="panel p-6"><h2 className="mb-5 text-lg font-semibold">研究与对话</h2>{!research.packageId && <ResearchForm projectId={projectId} onSubmit={research.create} loading={research.creating} disabled={busy} />}
        {research.packageId && !snapshot && <p className="muted text-sm">正在读取对话…</p>}
        {conversation.length > 0 && <section aria-label="对话记录" className="space-y-5">{conversation.map((event) => <article id={`research-reply-${event.id}`} key={event.id} className="border-b border-[#e1e6dc] pb-4"><h3 className="mb-2 text-sm font-semibold">{event.type === "user_message" ? "你" : "Agent"}</h3><div className="break-words text-sm"><MarkdownViewer content={event.message} onEvidenceClick={setEvidenceId} /></div>{event.type === "assistant_message" && <FavoriteButton kind="reply" targetId={event.id} />}</article>)}</section>}
        <div id="research-progress" className="sf-action-target"><ResearchProgress events={snapshot?.events ?? []} status={snapshot?.status} taskState={snapshot?.taskState} connection={research.connection} /></div>
        {snapshot?.clarifications.map((question) => <ClarificationCard key={question.id} question={question} packageId={snapshot.id} onAnswered={research.refresh} />)}
        {snapshot?.summary && !conversation.some((event) => event.type === "assistant_message") && <section id="research-summary" className="mt-6 border-t border-[#e1e6dc] pt-5"><FavoriteButton kind="research" targetId={snapshot.id} /><h3 className="mb-3 text-sm font-semibold">Agent 回复</h3><div className="text-sm"><MarkdownViewer content={snapshot.summary} /></div></section>}
        {snapshot && <form className="mt-6 space-y-3 border-t border-[#e1e6dc] pt-5" onSubmit={async (e) => { e.preventDefault(); setSending(true); try { await research.sendMessage(message); setMessage(""); } catch (error) { research.setError(error instanceof Error ? error.message : "发送失败。"); } finally { setSending(false); } }}><label>继续与 Agent 对话<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} required minLength={1} maxLength={5000} placeholder="继续聊天、提出新任务，或要求研究和更新文档……" /></label><button className="secondary" disabled={sending || !message.trim() || busy}>{sending ? "正在发送…" : "发送"}</button></form>}
      </section>
      <section className="panel min-h-[600px] min-w-0 overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5"><div><h2 className="text-lg font-semibold">项目工作区</h2><p className="muted mt-1 text-xs">{snapshot ? `${snapshot.title}${hasWorkspace ? ` · ${files.length} 份已生成${filePlan.length ? ` / ${filePlan.length} 份计划` : ""}` : ""}` : "需要研究或生成文档时，文件会显示在这里"}</p></div><DownloadButtons packageId={research.packageId} filename={selected} hasFiles={files.length > 0} hasCurrent={!!current} /></div>
        {filePlan.length > 0 && <FilePlan items={filePlan} files={files} />}
        {snapshot && (hasWorkspace || snapshot.evidence.length > 0) && <EvidencePanel key={snapshot.id} projectId={projectId} packageId={snapshot.id} evidenceCards={snapshot.evidence} revision={snapshot.events.at(-1)?.sequence ?? 0} onSelect={setEvidenceId} />}
        {hasWorkspace && <FileTabs filePlan={filePlan} files={files} selected={selected} onSelect={setSelected} disabled={editing} />}
        {current && snapshot ? <div className="p-6 lg:p-8"><div className="muted mb-6 flex items-center justify-between border-b border-[#e9ece4] pb-3 text-xs"><span>版本 {current.version} · {current.updatedBy === "user" ? "你更新了此文件" : "Agent 生成"}</span><span>{current.lockedBy ? "正在编辑" : "已保存"}</span><FavoriteButton kind="file" targetId={`${snapshot.id}:${selected}`} /></div><MarkdownEditor key={`${snapshot.id}:${selected}`} file={current} packageId={snapshot.id} onSaved={research.refresh} onEditingChange={setEditing} />{!editing && <MarkdownViewer content={current.content} onEvidenceClick={setEvidenceId} />}</div> : <div className="flex min-h-[430px] flex-col items-center justify-center px-8 text-center"><span className="mb-5 text-4xl text-[#9eb6a9]">◇</span><h3 className="text-lg font-medium">{hasWorkspace ? "证据正在成为你的计划" : "从对话开始，按需推进任务"}</h3><p className="muted mt-3 max-w-md text-sm leading-7">{hasWorkspace ? `${selected} 尚未生成。你可以在左侧查看任务进度。` : "聊天和任务回复显示在左侧。需要研究或生成文档时，文件计划与 Markdown 文档会出现在这里。"}</p></div>}
      </section>
    </div>
    {snapshot && evidenceId && <EvidenceDetail key={`${snapshot.id}:${evidenceId}`} packageId={snapshot.id} evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />}
  </section>;
}
