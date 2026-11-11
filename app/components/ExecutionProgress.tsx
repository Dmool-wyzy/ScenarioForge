"use client";
import { useEffect, useState } from "react";
import type { ResearchEvent } from "@/lib/types";
import type { ExecutionView, ExecutionProgress as Progress } from "@/lib/workspace-agent/types";
type Entry = { event: ResearchEvent; progress?: Progress };

function progressOf(event: ResearchEvent): Progress | undefined {
  const value = (event.payload as { progress?: Progress } | null)?.progress;
  return value && typeof value.operationId === "string" && typeof value.action === "string"
    && ["started", "completed", "failed", "waiting"].includes(value.phase) ? value : undefined;
}
function duration(milliseconds: number) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} 毫秒` : `${(milliseconds / 1000).toFixed(1)} 秒`;
}
function phaseLabel(progress: Progress | undefined, active: boolean) {
  if (!progress) return "记录";
  if (progress.phase === "failed") return "操作失败";
  if (progress.phase === "completed") return progress.status === "unavailable" ? "未执行" : progress.status === "failed" ? "未通过" : "已完成";
  if (!active) return "未记录完成";
  return progress.phase === "waiting" ? "等待" : "进行中";
}

export default function ExecutionProgress({ run, events }: { run: ExecutionView; events: ResearchEvent[] }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const deadline = Math.min(...(run.commandApprovals ?? []).map(approval => Date.parse(approval.expiresAt)).filter(time => Number.isFinite(time) && time > clock));
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, deadline - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [run.commandApprovals, clock]);
  const related = events.filter(event => event.type.startsWith("execution_")
    && (event.payload as { executionId?: string } | null)?.executionId === run.id).sort((a, b) => a.sequence - b.sequence);
  const entries: Entry[] = [], positions = new Map<string, number>();
  for (const event of related) {
    const progress = progressOf(event), index = progress ? positions.get(progress.operationId) : undefined;
    if (index !== undefined) entries[index] = { event, progress };
    else { if (progress) positions.set(progress.operationId, entries.length); entries.push({ event, progress }); }
  }
  entries.sort((a, b) => a.event.sequence - b.event.sequence);
  const active = ["queued", "running", "stopping"].includes(run.status);
  const attemptBoundary = related.filter(event => ["execution_queued", "execution_started", "execution_stopped", "execution_failed", "execution_completed"].includes(event.type)).at(-1)?.sequence ?? -1;
  const terminal: Record<string, string> = {
    queued: "等待执行", stopping: "正在停止任务", stopped: "任务已停止，已保存文件保留。",
    completed: "本轮完成，请审查文件与验证结果。", review: "本轮结束，等待人工验证。", failed: "任务已中断，请查看错误信息。",
  };
  const pendingApproval = run.target === "local" && run.commandApprovals?.some(approval => Date.parse(approval.expiresAt) > clock);
  const expiredApproval = run.target === "local" && run.commandApprovals?.length && !pendingApproval;
  const current = terminal[run.status] ?? (pendingApproval ? "等待你批准本机命令" : expiredApproval ? "命令审批已过期，等待任务更新。" : related.at(-1)?.message ?? "等待 Agent 更新进度。");
  return <div className="mt-3 min-w-0">
    <p role="status" aria-label="当前执行步骤" className="rounded-lg border border-[#dce1d9] bg-[#f8faf6] px-3 py-2 text-xs leading-6">
      <span className="muted">当前步骤 · </span>{current}
    </p>
    {entries.length > 0 && <details className="mt-2" open={active}>
      <summary className="cursor-pointer text-sm">执行进度 · {entries.length} 条操作记录</summary>
      <ol aria-label="执行任务进度" className="mt-3 max-h-72 space-y-2 overflow-auto text-xs">{entries.map(({ event, progress }) => {
        const failed = event.type === "execution_failed" || progress?.phase === "failed" || progress?.status === "failed";
        const hasDetail = Boolean(progress?.paths?.length || progress?.command?.length || progress?.skill || progress?.fileCount !== undefined);
        return <li key={progress?.operationId ?? event.id} className={`min-w-0 border-l-2 pl-3 ${failed ? "border-red-400" : "border-[#b5cbb6]"}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-6">
            <span className={failed ? "text-red-700" : "muted"}>{phaseLabel(progress, active && event.sequence > attemptBoundary)}</span>
            <time className="muted" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time>
            {typeof progress?.durationMs === "number" && Number.isFinite(progress.durationMs) && progress.durationMs >= 0 && <span className="muted">耗时 {duration(progress.durationMs)}</span>}
          </div>
          <p className="break-words leading-6">{event.message}</p>
          {hasDetail && <details className="mt-1">
            <summary className="cursor-pointer text-[#48634d]">操作详情</summary>
            {progress?.skill && <p className="mt-1 break-all">技能：{progress.skill.filename} v{progress.skill.version}</p>}
            {typeof progress?.fileCount === "number" && <p className="mt-1">涉及文件：{progress.fileCount} 个</p>}
            {progress?.paths && <ul aria-label="操作文件" className="mt-1 list-inside list-disc space-y-1">{progress.paths.map((path, index) => <li key={index} className="break-all font-mono">{path}</li>)}</ul>}
            {progress?.command && <pre aria-label="操作命令参数" className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded bg-[#f4f6f0] p-2">{JSON.stringify(progress.command, null, 2)}</pre>}
          </details>}
        </li>;
      })}</ol>
    </details>}
  </div>;
}
