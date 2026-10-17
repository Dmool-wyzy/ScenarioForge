import type { ResearchEvent } from "@/lib/types";
const labels: Record<string, string> = { created: "等待开始", researching: "研究进行中", completed: "研究已完成", failed: "研究失败", waiting_for_user: "等待你的回答", blocked: "研究已阻塞", waiting_for_edit: "等待编辑完成" };
function eventMessage(event: ResearchEvent) {
  const payload = event.payload as { provider?: string; query?: string; resultCount?: number; code?: string; message?: string } | null;
  if (payload?.provider) {
    if (event.type === "search_started") return `正在检索 [${payload.provider}]：${payload.query}`;
    if (event.type === "evidence_found" && typeof payload.resultCount === "number") return `[${payload.provider}] 搜索完成：${payload.resultCount} 条结果 · ${payload.query}`;
    if (event.type === "search_failed") return `搜索失败 [${payload.provider}] · ${payload.code}：${payload.message}${payload.query ? `（${payload.query}）` : ""}`;
  }
  return event.type === "research_completed" ? "研究完成，工作区已就绪" : event.message;
}
export default function ResearchProgress({ events, status, connection }: { events: ResearchEvent[]; status?: string; connection: string }) {
  return <section className="mt-7 border-t border-[#e1e6dc] pt-5" aria-live="polite"><div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold">研究进度</h3><span className="rounded-full bg-[#ecf2e9] px-2 py-1 text-xs text-[#527060]">{status ? labels[status] ?? status : "等待目标"}</span></div>{connection === "reconnecting" && <p className="mb-3 text-xs text-amber-700">连接中断，正在自动重连并补取进度…</p>}{events.length ? <ol className="max-h-80 space-y-4 overflow-auto">{events.map((event) => <li key={event.id} className="flex gap-3 text-sm"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${["research_failed", "search_failed", "tool_failed"].includes(event.type) ? "bg-red-500" : "bg-[#79a18b]"}`} /><div className="min-w-0"><p className="break-words leading-6">{eventMessage(event)}</p><time className="muted text-[11px]" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time></div></li>)}</ol> : <p className="muted text-sm leading-7">研究开始后，这里会显示问题拆解、来源检索和文件生成进度。</p>}</section>;
}
