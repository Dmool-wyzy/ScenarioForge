"use client";

import { useEffect, useId, useRef, useState } from "react";
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
import AgentWorkspace, { type WorkspaceConnection } from "./AgentWorkspace";
import ResearchSubmitMode, { type ResearchMode } from "./ResearchSubmitMode";
import DocumentProposalEditor from "./DocumentProposalEditor";
import WorkspaceNavigation, { type WorkspaceView } from "./WorkspaceNavigation";

function initialWorkspaceView(): WorkspaceView {
  if (typeof window === "undefined") return "research";
  const url = new URL(window.location.href);
  const researchTarget = /^(#clarification-|#research-|#saved-evidence-)/.test(url.hash) || url.searchParams.has("file");
  return !researchTarget && url.searchParams.get("workspace") === "execution" ? "execution" : "research";
}

export default function Workspace({ projectId, projectName, initialPackageId }: { projectId: string; projectName: string; initialPackageId?: string | null }) {
  const research = useResearch(projectId, initialPackageId);
  const idBase = useId();
  const [view, setView] = useState<WorkspaceView>(initialWorkspaceView);
  const [connection, setConnection] = useState<WorkspaceConnection | null>(null);
  const [selected, setSelected] = useState<WorkspaceFilename>(() => typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("file") || "README.md" : "README.md");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<ResearchMode>("documents");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ packageId: string; request: string; sequence: number }>();
  const [dismissedProposal, setDismissedProposal] = useState<string | null>(null);
  const proposalPanel = useRef<HTMLDivElement>(null);
  const scrolledProposal = useRef("");
  const history = useRef<HTMLDivElement>(null);
  const followHistory = useRef(true);
  const snapshot = research.snapshot;
  const files = snapshot?.files ?? [];
  const filePlan = snapshot?.filePlan ?? [];
  const filename = files.some(file => file.filename === selected) || filePlan.some(item => item.filename === selected) ? selected : files[0]?.filename ?? selected;
  const current = files.find((f) => f.filename === filename);
  const busy = research.planningDocuments || research.generatingDocuments || (!!snapshot && ["queued", "running"].includes(snapshot.taskState));
  const blocked = !!snapshot && ["waiting_for_user", "blocked", "waiting_for_edit"].includes(snapshot.status);
  const conversation = snapshot?.events.filter((event) => event.type === "user_message" || event.type === "assistant_message") ?? [];
  const hasWorkspace = filePlan.length > 0 || files.length > 0;
  const proposal = snapshot?.documentProposal && snapshot.documentProposal.id !== dismissedProposal ? snapshot.documentProposal : null;
  const lastMessageId = conversation.at(-1)?.id;
  useEffect(() => {
    if (history.current && followHistory.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastMessageId]);
  useEffect(() => {
    if (proposal?.id && proposal.id !== scrolledProposal.current && view === "research") {
      proposalPanel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); scrolledProposal.current = proposal.id;
    }
  }, [proposal?.id, view]);
  useEffect(() => {
    const syncView = () => setView(initialWorkspaceView());
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);
  const changeView = (next: WorkspaceView) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "execution") { url.searchParams.set("workspace", "execution"); url.searchParams.delete("file"); url.hash = ""; }
    else url.searchParams.delete("workspace");
    window.history.replaceState(null, "", url);
  };
  const previewDocuments = async (request?: string) => {
    if (!snapshot) return;
    try { await research.previewDocuments(request ?? (message.trim() || snapshot.goal)); if (request === undefined) setMessage(""); setDismissedProposal(null); }
    catch (error) { research.setError(error instanceof Error ? error.message : "无法预览文档清单。"); }
  };
  return <section aria-label={`${projectName}的研究工作区`}>
    <WorkspaceNavigation projectName={projectName} view={view} onViewChange={changeView} connection={connection} idBase={idBase} researchBusy={busy} editing={editing} />
    {research.error && <div role="alert" className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{research.error}</p><button aria-label="关闭错误提示" onClick={() => research.setError("")}>×</button></div>}
    <div role="tabpanel" id={`${idBase}-panel-research`} aria-labelledby={`${idBase}-tab-research`} hidden={view !== "research"} className="sf-workspace-view" tabIndex={0}>
    <div className="sf-research-grid">
      <section aria-label="研究与对话" className="panel sf-research-panel"><h2 className="shrink-0 px-6 py-5 text-lg font-semibold">研究与对话</h2>
        <div ref={history} data-testid="research-history-scroll" className="sf-research-history px-6 pb-5" onScroll={event => { const element = event.currentTarget; followHistory.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
        {!research.packageId && <ResearchForm projectId={projectId} onSubmit={research.create} loading={research.creating} disabled={busy} mode={mode} onModeChange={setMode} />}
        {research.packageId && !snapshot && <p className="muted text-sm">正在读取对话…</p>}
        {conversation.length > 0 && <section aria-label="对话记录" className="space-y-5">{conversation.map((event) => <article id={`research-reply-${event.id}`} key={event.id} className="border-b border-[#e1e6dc] pb-4"><h3 className="mb-2 text-sm font-semibold">{event.type === "user_message" ? "你" : "Agent"}</h3><div className="break-words text-sm"><MarkdownViewer content={event.message} onEvidenceClick={setEvidenceId} /></div>{event.type === "assistant_message" && <FavoriteButton kind="reply" targetId={event.id} />}</article>)}</section>}
        <details className="mt-4" open={busy || conversation.length === 0}><summary className="cursor-pointer text-xs text-[#527060]">研究与文档进度</summary><div id="research-progress" className="sf-action-target"><ResearchProgress events={snapshot?.events ?? []} status={snapshot?.status} taskState={snapshot?.taskState} connection={research.connection} /></div></details>
        {snapshot?.clarifications.map((question) => <ClarificationCard key={question.id} question={question} packageId={snapshot.id} onAnswered={research.refresh} />)}
        {snapshot?.summary && !conversation.some((event) => event.type === "assistant_message") && <section id="research-summary" className="mt-6 border-t border-[#e1e6dc] pt-5"><FavoriteButton kind="research" targetId={snapshot.id} /><h3 className="mb-3 text-sm font-semibold">Agent 回复</h3><div className="text-sm"><MarkdownViewer content={snapshot.summary} /></div></section>}
        </div>
        {snapshot && <form data-testid="research-composer" className="sf-research-composer space-y-3 border-t border-[#e1e6dc] px-6 py-5" onSubmit={async (event) => {
          event.preventDefault();
          if (busy || sending || (mode === "documents" && (editing || blocked))) return;
          if (mode === "documents") { await previewDocuments(); return; }
          if (!message.trim()) return;
          setSending(true);
          try { await research.sendMessage(message); setMessage(""); }
          catch (error) { research.setError(error instanceof Error ? error.message : "发送失败。"); }
          finally { setSending(false); }
        }}>
          <ResearchSubmitMode mode={mode} onChange={setMode} disabled={busy || sending} />
          <label>继续与 Agent 对话<textarea rows={2} value={message} onChange={(event) => setMessage(event.target.value)} required={mode === "chat"} minLength={1} maxLength={5000} placeholder={mode === "documents" ? "补充方案要求；留空则根据已有需求和对话规划文档……" : "继续讨论需求，或明确要求联网调研……"} /></label>
          <button className="primary w-full" disabled={busy || sending || (mode === "documents" ? editing || blocked : !message.trim())}>{research.planningDocuments ? "正在规划清单…" : busy || sending ? "正在处理…" : mode === "documents" ? "预览文档清单" : "发送"}</button>
          {blocked && mode === "documents" && <p className="text-xs text-amber-800">请先回答阻塞问题或结束文件编辑，再生成方案；仍可切换到“仅讨论”。</p>}
        </form>}
      </section>
      <section aria-label="研究文档" className="panel sf-research-panel"><div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-[#e9ece4] px-6 py-5"><div className="min-w-0"><h2 className="text-lg font-semibold">研究文档</h2><p className="muted mt-1 break-words text-xs">{snapshot ? `${snapshot.title}${hasWorkspace ? ` · ${files.length} 份已保存${filePlan.length ? ` / ${filePlan.length} 份计划` : ""}` : ""}` : "方案和研究 Markdown 会保存在这里"}</p></div><DownloadButtons packageId={research.packageId} filename={filename} hasFiles={files.length > 0} hasCurrent={!!current} /></div>
        <div data-testid="research-document-scroll" className="sf-research-document-scroll">
        {snapshot && proposal && <div ref={proposalPanel}><DocumentProposalEditor key={proposal.id} proposal={proposal} files={files} stale={snapshot.documentProposalStale} disabled={busy || sending || editing || blocked} submitting={research.generatingDocuments} onConfirm={async documents => {
          try { await research.generateDocuments(proposal.id, documents); }
          catch (error) { research.setError(error instanceof Error ? error.message : "无法生成所选文档。"); }
        }} onCancel={() => setDismissedProposal(proposal.id)} onPreview={() => previewDocuments(proposal.request)} /></div>}
        {snapshot && files.length > 0 && <div className="mx-6 mb-5 rounded-lg border border-[#bfcfc3] bg-[#f7f9f4] p-4"><p className="text-sm font-medium">确认技能，继续执行</p><p className="muted mt-2 text-xs leading-6">确认文档后进入执行工作区，调整所选技能和要求，再手动开始执行。启动时固定文档版本。</p><button type="button" className="primary mt-3" disabled={busy || sending || editing || blocked} onClick={() => {
          setHandoff(previous => ({ packageId: snapshot.id, request: snapshot.goal.slice(0, 5000), sequence: (previous?.sequence ?? 0) + 1 })); changeView("execution");
        }}>使用这些文档继续执行</button></div>}
        {filePlan.length > 0 && <FilePlan items={filePlan} files={files} />}
        {snapshot && (hasWorkspace || snapshot.evidence.length > 0) && <EvidencePanel key={snapshot.id} projectId={projectId} packageId={snapshot.id} evidenceCards={snapshot.evidence} revision={snapshot.events.at(-1)?.sequence ?? 0} onSelect={setEvidenceId} />}
        {hasWorkspace && <FileTabs filePlan={filePlan} files={files} selected={filename} onSelect={setSelected} disabled={editing} />}
        {current && snapshot ? <div className="p-6 lg:p-8"><div className="muted mb-6 flex items-center justify-between border-b border-[#e9ece4] pb-3 text-xs"><span>版本 {current.version} · {current.updatedBy === "user" ? "你更新了此文件" : "Agent 生成"}</span><span>{current.lockedBy ? "正在编辑" : "已保存"}</span><FavoriteButton kind="file" targetId={`${snapshot.id}:${filename}`} /></div><MarkdownEditor key={`${snapshot.id}:${filename}`} file={current} packageId={snapshot.id} onSaved={research.refresh} onEditingChange={setEditing} />{!editing && <MarkdownViewer content={current.content} onEvidenceClick={setEvidenceId} />}</div> : !proposal && <div className="sf-research-empty flex flex-col items-center justify-center px-8 py-10 text-center"><span className="mb-5 text-4xl text-[#9eb6a9]">◇</span><h3 className="text-lg font-medium">{hasWorkspace ? "文档正在生成" : busy ? "正在处理当前需求" : "还没有保存的方案文档"}</h3><p className="muted mt-3 max-w-md text-sm leading-7">{hasWorkspace ? `${filename} 尚未生成。你可以在左侧查看研究与文档进度。` : snapshot ? "先根据当前需求规划文档，确认文件名、用途和内容要点后再生成正文。保存的文档可作为技能交给执行 Agent。" : "在左侧输入目标，使用默认的“生成方案”模式预览清单。确认生成的 Markdown 会显示在这里。"}</p>{snapshot && !hasWorkspace && <button type="button" className="primary mt-5" disabled={busy || sending || editing || blocked} onClick={() => void previewDocuments()}>根据当前需求规划文档</button>}</div>}
        </div>
      </section>
    </div>
    {snapshot && evidenceId && <EvidenceDetail key={`${snapshot.id}:${evidenceId}`} packageId={snapshot.id} evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />}
    </div>
    <div role="tabpanel" id={`${idBase}-panel-execution`} aria-labelledby={`${idBase}-tab-execution`} hidden={view !== "execution"} className="sf-workspace-view" tabIndex={0}>
      <AgentWorkspace projectId={projectId} packageId={research.packageId} revision={snapshot?.events.at(-1)?.sequence ?? 0} onStarted={research.select} handoff={handoff} events={snapshot?.events ?? []} researchBusy={busy || editing} active={view === "execution"} onConnectionChange={setConnection} />
    </div>
  </section>;
}
