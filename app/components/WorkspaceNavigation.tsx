"use client";

import { useState } from "react";
import type { WorkspaceConnection } from "./AgentWorkspace";

export type WorkspaceView = "research" | "execution";

export default function WorkspaceNavigation({ projectName, view, onViewChange, connection, idBase, researchBusy, editing }: {
  projectName: string; view: WorkspaceView; onViewChange: (view: WorkspaceView) => void;
  connection: WorkspaceConnection | null; idBase: string; researchBusy: boolean; editing: boolean;
}) {
  const [directoryExpanded, setDirectoryExpanded] = useState(false);
  const [copyState, setCopyState] = useState<{ directory: string; status: "copied" | "failed" } | null>(null);
  const local = connection?.target === "local";
  const directory = local ? connection.directory : null;
  const connectionText = !connection || connection.loading ? "正在读取工作区连接…" : local
    ? connection.runnerId ? `${connection.runnerLabel ?? "本地 Runner"} · ${connection.online ? "Runner 在线" : "Runner 离线"}` : "尚未连接 Runner"
    : `GitHub 仓库 · ${connection.repositoryEnabled ? "已就绪" : "尚未关联"}`;
  const views: { value: WorkspaceView; label: string }[] = [{ value: "research", label: "方案与文档" }, { value: "execution", label: "执行工作区" }];
  return <header aria-label="项目工作区导航" className="sf-workspace-toolbar">
    <div className="sf-workspace-toolbar-top">
      <div className="sf-workspace-heading"><p>当前项目</p><h2 title={projectName}>{projectName}</h2></div>
      <div role="group" aria-label="工作区连接概况" className="sf-workspace-connection">
        <p role="status" aria-live="polite" className="sf-workspace-connection-status"><span aria-hidden="true" className={`sf-workspace-status-dot${local && connection?.online ? " is-online" : ""}`} />{connectionText}</p>
        {local && <div className="sf-workspace-directory-line">
          <p title={directory ?? undefined} className={directoryExpanded ? "is-expanded" : ""}>{directory ?? (connection?.runnerId ? "目录尚未上报，请重启 Runner。" : "请选择已配对的本地目录。")}</p>
          {directory && <div className="sf-workspace-directory-actions">
            <button type="button" aria-expanded={directoryExpanded} onClick={() => setDirectoryExpanded(value => !value)}>{directoryExpanded ? "收起" : "展开"}</button>
            <button type="button" aria-label="复制当前连接目录" onClick={async () => {
              try { await navigator.clipboard.writeText(directory); setCopyState({ directory, status: "copied" }); }
              catch { setDirectoryExpanded(true); setCopyState({ directory, status: "failed" }); }
            }}>复制</button>
          </div>}
        </div>}
        {copyState?.directory === directory && local && <p role="status" className="muted mt-1 text-xs">{copyState.status === "copied" ? "目录已复制" : "请选中完整目录手动复制。"}</p>}
      </div>
    </div>
    <div role="tablist" aria-label="项目工作视图" className="sf-workspace-tabs" onKeyDown={event => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const next: WorkspaceView = event.key === "Home" ? "research" : event.key === "End" ? "execution" : view === "research" ? "execution" : "research";
      onViewChange(next); document.getElementById(`${idBase}-tab-${next}`)?.focus();
    }}>
      {views.map(item => <button key={item.value} type="button" role="tab" id={`${idBase}-tab-${item.value}`} aria-controls={`${idBase}-panel-${item.value}`} aria-label={item.label} aria-selected={view === item.value} tabIndex={view === item.value ? 0 : -1} onClick={() => onViewChange(item.value)}>
        {item.label}
        {item.value === "research" && (researchBusy || editing) && <span aria-hidden="true" className="sf-workspace-tab-note">{editing ? "编辑中" : "处理中"}</span>}
        {item.value === "execution" && !!connection?.pendingApprovalCount && <span aria-hidden="true" className="sf-workspace-tab-note is-pending">待审批 {connection.pendingApprovalCount}</span>}
        {item.value === "execution" && !connection?.pendingApprovalCount && !!connection?.activeTaskCount && <span aria-hidden="true" className="sf-workspace-tab-note">执行中 {connection.activeTaskCount}</span>}
      </button>)}
      {!!connection?.pendingApprovalCount && <button type="button" className="sf-workspace-approval-link" onClick={() => onViewChange("execution")}>查看待审批命令</button>}
    </div>
  </header>;
}
