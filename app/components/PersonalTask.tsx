"use client";
import FavoriteButton from "./FavoriteButton";


import { useState } from "react";
import { apiRequest } from "@/hooks/useResearch";

export type PersonalTaskData = { id: string; objective: string; context: string; status: string; result: string | null; error: string | null; revision: number; conversation: { role: string; content: string }[]; canRecover: boolean; modelRequests: number; inputTokens: number; outputTokens: number; createdAt: string; package: { id: string; title: string } };
const statuses: Record<string, string> = { running: "生成初稿中", chatting: "个人 Agent 回复中", review: "待你确认提交", submitted: "已提交团队", completed: "已完成（历史任务）", failed: "执行失败" };

export default function PersonalTask({ projectId, task, refresh }: { projectId: string; task: PersonalTaskData; refresh: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const delivery = draft ?? task.result ?? "";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const editable = ["review", "failed"].includes(task.status);
  const act = async (action: "message" | "submit" | "recover") => {
    setPending(true); setError("");
    try {
      await apiRequest(`/api/projects/${projectId}/personal-agent/tasks/${task.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, revision: task.revision, ...(action === "message" ? { message } : action === "submit" ? { result: delivery } : {}) }) });
      window.dispatchEvent(new Event("scenarioforge:actions-changed"));
      if (action === "message") { setMessage(""); setDraft(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { await refresh().catch(() => {}); setPending(false); }
  };
  return <li id={`personal-task-${task.id}`} className="sf-action-target py-4 first:pt-1">
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm text-[#344631]">{task.objective}</strong><span className="text-xs text-[#65735d]">{statuses[task.status] ?? task.status}</span></div>
    <p className="mt-1 text-xs text-[#65735d]">{task.package.title} · {new Date(task.createdAt).toLocaleString()}</p>
    {task.context && <details className="mt-2 text-xs text-[#65735d]"><summary className="cursor-pointer">查看任务上下文</summary><p className="mt-2 whitespace-pre-wrap leading-5">{task.context}</p></details>}
    <details className="mt-3 rounded-lg border border-[#e3e8db] p-4" open={editable || task.status === "chatting"}>
      <summary className="cursor-pointer text-sm">与我的 Agent 讨论 · 仅本人可见</summary>
      <p className="mt-2 text-xs leading-5 text-[#65735d]">可以追问、补充要求、修改方案。每次发送调用一次个人模型；含初稿每项最多 6 次，单次最多 2,048 输出 tokens。确认提交才会将下方交付内容发给团队，并触发一次顶层审核轮次。</p>
      <div className="mt-3 max-h-96 space-y-3 overflow-y-auto" aria-label="个人任务对话">{task.conversation.map((row, index) => <div key={index} className="rounded-lg bg-[#f4f6f0] p-3"><strong className="text-xs text-[#45633c]">{row.role === "user" ? "我" : "个人 Agent"}</strong><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{row.content}</p>{row.role === "assistant" && <FavoriteButton kind="message" targetId={`${task.id}:${index}`} />}</div>)}</div>
      {editable && <form className="mt-4" onSubmit={event => { event.preventDefault(); void act("message"); }}><label className="text-xs">补充要求或追问<textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} rows={3} disabled={pending || task.modelRequests >= 6} placeholder="例如：把第二条改成可直接操作的步骤，并给出判断成功的标准。" /></label><button className="secondary mt-2" disabled={pending || task.modelRequests >= 6 || !message.trim()}>{pending ? "处理中…" : "发送给个人 Agent"}</button></form>}
      {task.canRecover && <button className="secondary mt-3" disabled={pending} onClick={() => void act("recover")}>恢复已超时的对话</button>}
    </details>
    {editable ? <form className="mt-4" onSubmit={event => { event.preventDefault(); void act("submit"); }}><label className="text-sm">待提交的交付内容<textarea rows={6} value={delivery} onChange={event => setDraft(event.target.value)} maxLength={12000} disabled={pending} /></label><button className="primary mt-3" disabled={pending || !delivery.trim()}>确认提交给团队</button><p className="mt-2 text-xs text-[#65735d]">仅发送这份内容，个人讨论记录不会共享。提交后本任务交付锁定。</p></form> : task.result && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#344631]">{task.result}</p>}
    {(error || task.error) && <p role="alert" className="mt-3 text-xs text-[#9d5944]">{error || task.error}</p>}
    <p className="mt-2 text-[11px] text-[#65735d]">调用 {task.modelRequests} 次 · 输入 {task.inputTokens} / 输出 {task.outputTokens} tokens</p>
    {task.status === "submitted" && <a className="mt-3 inline-block text-xs underline" href={`/?project=${projectId}&package=${task.package.id}`}>查看团队审核对话</a>}
  </li>;
}
