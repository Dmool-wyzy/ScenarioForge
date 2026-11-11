"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import type { ExecutionView, SkillDescription } from "@/lib/workspace-agent/types";
import type { ResearchEvent } from "@/lib/types";
import WorkspaceDirectory from "./WorkspaceDirectory";
import ExecutionProgress from "./ExecutionProgress";

type LocalRunner = { id: string; label: string; online: boolean; lastSeenAt: string | null; workspaceDirectory?: string | null };
type Snapshot = { executions: ExecutionView[]; skills: SkillDescription[]; repositoryEnabled: boolean; userId: string; owner: boolean; runners?: LocalRunner[] };
type Detail = { head: string; diff: string; changedPaths: string[]; files: { path: string; size: number }[] };
type Pairing = { id: string; code: string; expiresAt: string; origin: string; projectId: string };
type CommandApproval = NonNullable<ExecutionView["commandApprovals"]>[number];
type CommandDecision = "approve_command" | "reject_command";
type Handoff = { packageId: string; request: string; sequence: number };
export type WorkspaceConnection = {
  target: "github" | "local";
  loading: boolean;
  runnerId: string | null;
  runnerLabel: string | null;
  directory: string | null;
  online: boolean;
  repositoryEnabled: boolean;
  activeTaskCount: number;
  pendingApprovalCount: number;
};
const labels: Record<string, string> = { queued: "等待执行", running: "正在执行", stopping: "正在停止", stopped: "已停止", completed: "本轮完成，待审查", review: "待人工验证", failed: "执行中断" };
const activeStatuses = new Set(["queued", "running", "stopping"]);

function LocalCommandApproval({ approval, busy, onDecision }: { approval: CommandApproval; busy: boolean; onDecision: (action: CommandDecision) => void }) {
  const [expired, setExpired] = useState(() => !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now());
  useEffect(() => {
    const remaining = Date.parse(approval.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setExpired(true), Number.isFinite(remaining) ? Math.max(0, remaining) : 0);
    return () => window.clearTimeout(timer);
  }, [approval.expiresAt]);
  return <div role="group" aria-label="待审批的本机命令" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-xs leading-6">
    <h4 className="text-sm font-semibold">等待你批准本机命令</h4>
      <p className="mt-2">命令会在本机 Docker 的无网络临时容器中运行，只能读取已导出的安全文件快照；不会挂载本机密钥或 Docker socket。命令输出会经过 ScenarioForge 服务端并发送给模型。容器内文件改动会丢弃，请通过 Agent 文件变更功能修改项目。每条命令仍须单独批准。</p>
    <pre aria-label="命令参数" className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-3">{JSON.stringify(approval.command, null, 2)}</pre>
    <p className="mt-2 break-all">绑定文件快照：{approval.head}</p>
    <p>{expired ? "审批已过期，请等待任务更新。" : `审批有效至 ${new Date(approval.expiresAt).toLocaleTimeString()}；批准仅用于本次命令。`}</p>
    <div className="mt-3 flex flex-wrap gap-3">
      <button type="button" className="primary" disabled={busy || expired} onClick={() => {
        if (Date.parse(approval.expiresAt) <= Date.now()) { setExpired(true); return; }
        onDecision("approve_command");
      }}>批准本次命令</button>
      <button type="button" className="secondary" disabled={busy || expired} onClick={() => {
        if (Date.parse(approval.expiresAt) <= Date.now()) { setExpired(true); return; }
        onDecision("reject_command");
      }}>拒绝执行</button>
    </div>
  </div>;
}

export default function AgentWorkspace({ projectId, packageId, revision, onStarted, handoff, events = [], researchBusy = false, active = true, onConnectionChange }: { projectId: string; packageId: string | null; revision: number; onStarted: (packageId: string) => void; handoff?: Handoff; events?: ResearchEvent[]; researchBusy?: boolean; active?: boolean; onConnectionChange?: (connection: WorkspaceConnection) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState("");
  const [request, setRequest] = useState(""), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [file, setFile] = useState<{ path: string; content: string; head: string } | null>(null);
  const [filename, setFilename] = useState("");
  const [target, setTarget] = useState<"github" | "local">("github"), [runnerId, setRunnerId] = useState("");
  const [runnerLabel, setRunnerLabel] = useState("本机项目"), [pairing, setPairing] = useState<Pairing | null>(null);
  const [handoffCount, setHandoffCount] = useState<number | null>(null);
  const [readyHandoff, setReadyHandoff] = useState("");
  const panel = useRef<HTMLElement>(null), requestField = useRef<HTMLTextAreaElement>(null), skillDetails = useRef<HTMLDetailsElement>(null);
  const handledHandoff = useRef("");
  const focusedHandoff = useRef("");
  const emittedConnection = useRef("");
  const known = useRef({ key: "", ids: new Set<string>() });
  const commandDecisionPending = useRef(false);
  const base = `/api/projects/${projectId}/executions`;
  const runnerBase = `/api/projects/${projectId}/local-runners`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await apiRequest<Snapshot>(`${base}${packageId ? `?package=${packageId}` : ""}`, { signal });
    if (signal?.aborted) return;
    setSnapshot(result);
    setRunnerId(current => result.runners?.some(runner => runner.id === current) ? current : result.runners?.find(runner => runner.online)?.id ?? "");
    const key = `${projectId}:${packageId ?? "new"}`, current = result.skills.filter(skill => skill.packageId === packageId);
    const handoffKey = handoff ? `${projectId}:${handoff.packageId}:${handoff.sequence}` : "";
    if (handoff && handoff.packageId === packageId && handledHandoff.current !== handoffKey) {
      handledHandoff.current = handoffKey;
      known.current = { key, ids: new Set(current.map(skill => skill.id)) };
      setSelected(current.map(skill => skill.id)); setRequest(handoff.request.slice(0, 5000)); setHandoffCount(current.length);
      setReadyHandoff(handoffKey);
    } else if (known.current.key !== key) { known.current = { key, ids: new Set(current.map(skill => skill.id)) }; setSelected(current.map(skill => skill.id)); setHandoffCount(null); }
    else { const added = current.filter(skill => !known.current.ids.has(skill.id)); if (added.length) setSelected(ids => [...ids, ...added.map(skill => skill.id)]); for (const skill of current) known.current.ids.add(skill.id); }
  }, [base, packageId, projectId, handoff]);
  useEffect(() => {
    const currentHandoff = handoff?.packageId === packageId ? `${projectId}:${handoff.packageId}:${handoff.sequence}` : "";
    if (!active || !readyHandoff || readyHandoff !== currentHandoff || focusedHandoff.current === readyHandoff) return;
    focusedHandoff.current = readyHandoff;
    if (skillDetails.current) skillDetails.current.open = true;
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); requestField.current?.focus({ preventScroll: true });
  }, [active, readyHandoff, handoff, packageId, projectId]);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取执行任务。"); });
    update(); const timer = window.setInterval(update, 4000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh, revision]);
  const selectedHead = snapshot?.executions.find(run => run.id === runId)?.head;
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    void apiRequest<Detail>(`${base}?run=${runId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [base, runId, selectedHead]);
  useEffect(() => {
    if (!runId || !filename) return;
    const controller = new AbortController();
    void apiRequest<{ path: string; content: string; head: string }>(`${base}?run=${runId}&file=${encodeURIComponent(filename)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setFile(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [base, runId, filename, selectedHead]);
  const act = async (executionId: string, action: "stop" | "resume") => {
    setBusy(true); setError("");
    try { await apiRequest(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, executionId }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败。"); } finally { setBusy(false); }
  };
  const decideCommand = async (executionId: string, approval: CommandApproval, action: CommandDecision) => {
    if (busy || commandDecisionPending.current) return;
    const run = snapshot?.executions.find(item => item.id === executionId);
    if (run?.target !== "local" || run.status !== "running" || run.createdBy !== snapshot?.userId) return;
    commandDecisionPending.current = true; setBusy(true); setError("");
    try {
      await apiRequest(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, executionId, commandId: approval.id }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "命令审批失败。"); }
    finally { commandDecisionPending.current = false; setBusy(false); }
  };
  const executions = [...(snapshot?.executions ?? [])].sort((first, second) => (Date.parse(second.createdAt) || 0) - (Date.parse(first.createdAt) || 0));
  const activeExecutions = executions.filter(run => activeStatuses.has(run.status));
  const hasActiveExecutions = activeExecutions.length > 0;
  const currentExecutions = hasActiveExecutions ? activeExecutions : executions.slice(0, 1);
  const currentIds = new Set(currentExecutions.map(run => run.id));
  const historicalExecutions = executions.filter(run => !currentIds.has(run.id));
  const selectedRunner = snapshot?.runners?.find(runner => runner.id === runnerId);
  const loading = snapshot === null;
  const connectionRunnerId = selectedRunner?.id ?? null, connectionRunnerLabel = selectedRunner?.label ?? null;
  const directory = selectedRunner?.workspaceDirectory ?? null, online = selectedRunner?.online ?? false;
  const repositoryEnabled = snapshot?.repositoryEnabled ?? false, activeTaskCount = activeExecutions.length;
  const pendingApprovalCount = activeExecutions.filter(run => run.target === "local" && run.status === "running" && run.createdBy === snapshot?.userId)
    .reduce((count, run) => count + (run.commandApprovals?.length ?? 0), 0);
  useEffect(() => {
    if (!onConnectionChange) return;
    const connection: WorkspaceConnection = { target, loading, runnerId: connectionRunnerId, runnerLabel: connectionRunnerLabel, directory, online, repositoryEnabled, activeTaskCount, pendingApprovalCount };
    const key = JSON.stringify(connection);
    if (emittedConnection.current === key) return;
    emittedConnection.current = key;
    onConnectionChange(connection);
  }, [onConnectionChange, target, loading, connectionRunnerId, connectionRunnerLabel, directory, online, repositoryEnabled, activeTaskCount, pendingApprovalCount]);
  const ready = target === "local" ? selectedRunner?.online : snapshot?.repositoryEnabled;
  const currentPairing = pairing?.projectId === projectId ? pairing : null;
  const pair = async () => {
    setBusy(true); setError("");
    try {
      const result = await apiRequest<Omit<Pairing, "origin" | "projectId">>(runnerBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pair", label: runnerLabel }) });
      setPairing({ ...result, origin: window.location.origin, projectId }); setRunnerId(result.id); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建配对码。"); } finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!runnerId) return;
    setBusy(true); setError("");
    try {
      await apiRequest(runnerBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", runnerId }) });
      if (currentPairing?.id === runnerId) setPairing(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法断开 Runner。"); } finally { setBusy(false); }
  };
  const renderExecution = (run: ExecutionView) => {
    if (!snapshot) return null;
    return <article key={run.id} data-execution-id={run.id} className="min-w-0 rounded-lg border border-[#dce1d9] p-4">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{labels[run.status] ?? run.status}</h3><span className="muted text-xs">第 {run.attempts} 次执行</span></div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{run.request}</p><p className="muted mt-2 break-all text-xs">{run.target === "local" ? "本地工作区 · " + (snapshot.runners?.find(runner => runner.id === run.runnerId)?.label ?? "原本地连接") : run.branch}</p>
      {run.target === "local" && <WorkspaceDirectory directory={run.workspaceDirectory} historical />}
      <p className="muted mt-1 text-xs">技能：{run.skills.map(skill => `${skill.filename} v${skill.version}`).join("、") || "未选择"}</p>
      <ExecutionProgress run={run} events={events} />
      {run.target === "local" && run.status === "running" && run.createdBy === snapshot.userId && run.commandApprovals?.map(approval => <LocalCommandApproval key={`${approval.id}:${approval.expiresAt}`} approval={approval} busy={busy} onDecision={action => void decideCommand(run.id, approval, action)} />)}
      {run.summary && <p className="mt-3 whitespace-pre-wrap break-words text-sm">{run.summary}</p>}{run.error && <p className="mt-2 text-sm text-red-700">{run.error}</p>}
      {run.verification.map((check, index) => <details key={index} className="mt-2 text-xs"><summary className="cursor-pointer">{check.kind === "syntax" ? "静态语法检查" : `命令：${check.command?.join(" ")}`} · {check.status === "passed" ? "通过" : check.status === "failed" ? "失败" : "未完成验证"}</summary><p className="muted mt-2">验证对应{run.target === "local" ? "文件快照" : "提交"}：{check.head.slice(0, 12)}；后续修改需要重新验证。</p><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap">{check.output}</pre></details>)}
      <div className="mt-3 flex flex-wrap gap-3 text-xs"><button className="secondary" disabled={busy || run.status === "queued"} onClick={() => { setDetail(null); setFile(null); setFilename(""); setError(""); setRunId(runId === run.id ? null : run.id); }}>查看文件与差异</button>
        {(snapshot.owner || run.createdBy === snapshot.userId) && <>{["queued", "running"].includes(run.status) && <button className="secondary" disabled={busy} onClick={() => void act(run.id, "stop")}>停止任务</button>}{["failed", "stopped", "review"].includes(run.status) && (run.target !== "local" || run.createdBy === snapshot.userId) && <button className="secondary" disabled={busy || hasActiveExecutions || researchBusy || run.attempts >= 3 || (run.target === "local" && !snapshot.runners?.some(runner => runner.id === run.runnerId && runner.online))} onClick={() => void act(run.id, "resume")}>{run.target === "local" ? "在原本地目录继续" : "从原分支继续"}</button>}</>}
      </div>
      {runId === run.id && detail && <div className="mt-4"><label>{run.target === "local" ? "任务变更文件" : "任务分支文件"}<select aria-label={run.target === "local" ? "任务变更文件" : "任务分支文件"} value={filename} onChange={event => setFilename(event.target.value)}><option value="">选择文件预览</option>{detail.files.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select></label>
        <p className="muted mt-2 text-xs">{run.target === "local" ? "任务保存的文件快照" : "当前分支提交"}：{detail.head.slice(0, 12)}</p>
        {file && file.path === filename && file.head === detail.head && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[#f4f6f0] p-3 text-xs">{file.content}</pre>}
        <details className="mt-3" open><summary className="cursor-pointer text-sm">本任务的变更差异</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[#f4f6f0] p-3 text-xs">{detail.diff || "尚无文件变更。"}</pre></details>
        <p className="muted mt-2 text-xs">{run.target === "local" ? "这里显示任务保存的变更快照。请在本机查看当前文件，并决定是否提交或推送。" : "审查后可在团队 Git 工作区选择此分支并合并。"}</p>
      </div>}
    </article>;
  };
  return <section ref={panel} aria-label="Agent 执行工作区" className="panel mb-6 scroll-mt-36 p-6">
    <h2 className="text-lg font-semibold">执行与验证</h2>
    <p className="muted mt-2 text-sm leading-6">选择本地目录或 GitHub 仓库，让 Agent 根据项目技能生成和修改文件，并记录验证结果。浏览或下载技能原文不影响执行。</p>
    {handoffCount !== null && <p role="status" className="mt-3 rounded-lg border border-[#cbdcc9] bg-[#f1f6ee] p-3 text-sm leading-6">{handoffCount ? `已带入当前方案的 ${handoffCount} 份技能文档和执行要求。` : "当前方案尚无已保存的技能文档，执行要求已带入。"}请确认文档版本、执行要求和工作方式，再点击“开始执行”。</p>}
    {researchBusy && <p className="mt-3 text-sm text-amber-800">方案仍在处理，请等文档保存完成后再启动或恢复执行任务。</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <fieldset className="mt-4">
      <legend className="text-sm font-medium">工作方式</legend>
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="workspace-target" value="local" checked={target === "local"} onChange={() => setTarget("local")} />本地工作区</label>
        <label className="flex items-center gap-2"><input type="radio" name="workspace-target" value="github" checked={target === "github"} onChange={() => setTarget("github")} />GitHub 仓库</label>
      </div>
    </fieldset>
    {target === "github" ? <div className="mt-3 text-sm">
      <p className="muted">Agent 在服务器的独立任务分支工作；审查后由你决定合并和推送。</p>
      {snapshot && !snapshot.repositoryEnabled && <p className="mt-2">请先在团队 Git 工作区创建或导入项目仓库。</p>}
    </div> : <div className="mt-3 rounded-lg border border-[#dce1d9] p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm">本地工作区连接<select aria-label="本地工作区连接" value={runnerId} onChange={event => setRunnerId(event.target.value)}>
          <option value="">选择已配对的 Runner</option>
          {snapshot?.runners?.map(runner => <option key={runner.id} value={runner.id}>{runner.label} · {runner.online ? "在线" : "离线"}</option>)}
        </select></label>
      </div>
      {selectedRunner && <p role="status" className="muted mt-2 text-xs">{selectedRunner.online ? "Runner 已连接，可以开始任务。" : "Runner 当前离线，请在本机启动 Runner。已保存的任务差异仍可浏览。"}</p>}
      {selectedRunner && <WorkspaceDirectory key={selectedRunner.id + selectedRunner.workspaceDirectory} directory={selectedRunner.workspaceDirectory} />}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm">连接与运行设置</summary>
        <div className="mt-3 space-y-3 border-t border-[#e1e6dc] pt-3">
          <p className="text-xs leading-6">Runner 在你的电脑上读写选定目录，改动直接保存在本地，由你决定提交和推送。Agent 读取的文件内容会经过 ScenarioForge 服务器和模型供应商。</p>
          <p className="muted text-xs leading-5">Runner 默认提供文件操作和静态语法检查。启用命令后，可在网页逐条批准运行测试；本机需安装 Docker Desktop 并预先准备 node:24-alpine 镜像。保持 Runner 在线才能执行任务。</p>
          <details className="text-xs leading-6">
            <summary className="cursor-pointer text-sm">运行本机测试命令</summary>
            <p className="mt-2">如需让 Agent 运行测试，请先停止当前 Runner，再在本机终端用以下命令启动。之后每条命令仍需由任务创建者在网页批准；未启用时会返回未执行。</p>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-[#f4f6f0] p-3">node --import tsx scripts/scenarioforge-local-runner.mjs run --allow-commands</pre>
          </details>
          <details>
            <summary className="cursor-pointer text-sm">连接新的本地目录</summary>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 text-sm">连接名称<input aria-label="本地连接名称" value={runnerLabel} onChange={event => setRunnerLabel(event.target.value)} maxLength={80} placeholder="例如：笔记本上的课题项目" /></label>
              <button type="button" className="secondary" disabled={busy || !runnerLabel.trim()} onClick={() => void pair()}>生成配对码</button>
            </div>
            {currentPairing && <div className="mt-3 text-xs leading-6">
              <p>在本机的 ScenarioForge 项目目录打开终端，执行以下命令。把示例目录替换成 Agent 要操作的项目目录。</p>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-[#f4f6f0] p-3">{`node --import tsx scripts/scenarioforge-local-runner.mjs pair --url ${currentPairing.origin} --code ${currentPairing.code} --directory "D:\\your-project"\nnode --import tsx scripts/scenarioforge-local-runner.mjs run`}</pre>
              <p className="muted mt-2">配对码仅可使用一次，{new Date(currentPairing.expiresAt).toLocaleTimeString()} 前有效。请勿分享配对码；连接凭证由本机 Runner 保存。</p>
              <button type="button" className="mt-1 underline" onClick={() => setPairing(null)}>隐藏配对信息</button>
            </div>}
          </details>
          <button type="button" className="secondary text-xs" disabled={busy || !runnerId} onClick={() => void revoke()}>撤销连接</button>
        </div>
      </details>
    </div>}
    <form className="mt-4 space-y-3" onSubmit={async event => {
      event.preventDefault(); if (researchBusy || busy || hasActiveExecutions || !ready || !request.trim()) return; setBusy(true); setError("");
      try {
        const result = await apiRequest<{ packageId: string }>(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", request, ...(packageId ? { packageId } : {}), skillIds: selected, target, ...(target === "local" ? { runnerId } : {}) }) });
        setRequest(""); setRunId(null); setDetail(null); setHandoffCount(null); onStarted(result.packageId); await refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "任务未能启动。"); } finally { setBusy(false); }
    }}>
      <details ref={skillDetails}><summary className="cursor-pointer text-sm">项目技能文件 · 已选 {selected.length} 份</summary><p className="muted mt-2 text-xs">请确认下列文档及版本。开始执行时固定所选正文和版本；之后编辑研究文档不会改变正在执行的任务，恢复原任务仍使用原快照。</p>
        <div className="mt-2 grid max-h-60 gap-2 overflow-auto sm:grid-cols-2">{snapshot?.skills.map(skill => <label key={skill.id} className="flex items-start gap-2 rounded border p-3 text-xs">
          <input type="checkbox" checked={selected.includes(skill.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, skill.id] : ids.filter(id => id !== skill.id))} />
          <span><strong>{skill.filename} · v{skill.version}</strong><span className="muted block">{skill.packageTitle} · {skill.kind === "workflow" ? "流程指导" : "研究参考"}</span><span className="block">{skill.purpose}</span><a className="underline" href={`/?project=${projectId}&package=${skill.packageId}&file=${encodeURIComponent(skill.filename)}`}>浏览原文</a><span> · </span><a className="underline" href={`/api/research/${skill.packageId}/files/${encodeURIComponent(skill.filename)}?download=1`}>下载</a></span>
        </label>)}</div>{snapshot?.skills.length === 0 && <p className="muted mt-2 text-xs">暂无已保存的技能文档。可先在“方案与文档”中生成方案，再使用这些文档继续执行；也可直接描述任务后执行。</p>}</details>
      <p className="muted text-xs" aria-live="polite">已选择 {selected.length} 份技能文档 · 启动时固定版本</p>
      <label>执行要求<textarea ref={requestField} aria-label="工作区执行要求" value={request} onChange={event => setRequest(event.target.value)} rows={3} maxLength={5000} placeholder="例如：根据所选技能，生成 src/config.ts 和对应测试，检查结果并修复问题。" required /></label>
      <button className="primary" disabled={busy || hasActiveExecutions || researchBusy || !ready || !request.trim()}>{busy ? "正在提交…" : "开始执行"}</button>
    </form>
    {currentExecutions.length > 0 && <section aria-label="当前执行任务" className="mt-5 min-w-0 space-y-4">
      <h3 className="text-sm font-medium">{hasActiveExecutions ? "当前任务" : "最近任务"}</h3>
      {currentExecutions.map(renderExecution)}
    </section>}
    {historicalExecutions.length > 0 && <details aria-label="历史执行任务" className="mt-5 min-w-0 rounded-lg border border-[#dce1d9] p-4">
      <summary className="cursor-pointer text-sm font-medium">历史任务 · {historicalExecutions.length} 条</summary>
      <div className="mt-4 min-w-0 space-y-4">{historicalExecutions.map(renderExecution)}</div>
    </details>}
  </section>;
}
