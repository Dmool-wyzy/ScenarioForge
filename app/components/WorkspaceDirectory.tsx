"use client";
import { useState } from "react";

export default function WorkspaceDirectory({ directory, historical = false }: { directory?: string | null; historical?: boolean }) {
  const [expanded, setExpanded] = useState(false), [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const copy = async () => {
    if (!directory) return;
    try {
      await navigator.clipboard.writeText(directory);
      setCopyState("copied");
    } catch { setExpanded(true); setCopyState("failed"); }
  };
  return <div role="group" aria-label={historical ? "本次执行目录" : "当前连接目录"} className="mt-2 min-w-0 rounded-lg bg-[#f4f6f0] px-3 py-2 text-xs">
    <p className="muted">{historical ? "本次执行目录" : "当前连接目录"}</p>
    {directory ? <>
      <p title={directory} className={`mt-1 min-w-0 font-mono ${expanded ? "whitespace-pre-wrap break-all" : "truncate"}`}>{directory}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" className="underline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起目录" : "展开完整目录"}</button>
        <button type="button" className="underline" onClick={() => void copy()}>复制目录</button>
        {copyState && <span role="status" className="muted">{copyState === "copied" ? "目录已复制" : "无法自动复制，请选中完整目录复制。"}</span>}
      </div>
    </> : <p className="mt-1 leading-5">{historical ? "此历史任务未记录执行目录。" : "目录尚未上报，请重启 Runner。"}</p>}
  </div>;
}
