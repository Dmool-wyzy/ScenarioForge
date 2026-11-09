"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import { actionReason, rankActions, urgency, type NextAction, type NextStepsSnapshot } from "@/lib/next-step-ranking";

function localDate(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function Deadline({ action, refresh }: { action: NextAction; refresh: () => Promise<void> }) {
  const [date, setDate] = useState(localDate(action.dueAt));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const save = async (clear = false) => {
    setBusy(true); setError("");
    try {
      await apiRequest(`/api/projects/${action.projectId}/my-action`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionKey: action.id, dueAt: clear ? null : new Date(date).toISOString() }) });
      await refresh();
      if (details.current) details.current.open = false;
    } catch (e) { setError(e instanceof Error ? e.message : "截止时间保存失败。"); }
    finally { setBusy(false); }
  };
  if (action.dueAt && action.deadlineSource === "task") {
    const dateOnly = action.deadlinePrecision === "date";
    const formatted = new Date(action.dueAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", ...(!dateOnly ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}) });
    return <div className="sf-action-deadline sf-action-deadline-fixed">
      <span>任务截止：<time dateTime={action.dueAt}>{formatted}{dateOnly ? " 当日结束" : ""}</time></span>
      <small>来自任务描述 · 北京时间{action.deadlineRelative ? " · 按创建时间换算" : ""}</small>
    </div>;
  }
  return <details className="sf-action-deadline" ref={details} onToggle={e => { if (e.currentTarget.open) setDate(localDate(action.dueAt)); }}>
    <summary>{action.dueAt ? `我的截止：${new Date(action.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "设置我的截止时间"}</summary>
    <form onSubmit={e => { e.preventDefault(); void save(); }}><label>我的截止时间<input type="datetime-local" min="2000-01-01T00:00" max="2100-12-31T23:59" required value={date} onChange={e => setDate(e.target.value)} disabled={busy} /></label><p>仅用于你的排序与提醒，使用本机时区。</p><div><button className="secondary" disabled={busy || !date}>{busy ? "保存中…" : "保存时间"}</button>{action.dueAt && <button type="button" className="sf-text-button" disabled={busy} onClick={() => void save(true)}>清除时间</button>}</div>{error && <p role="alert">{error}</p>}</form>
  </details>;
}
function ActionCard({ action, featured = false, reason, refresh, more, onMore }: { action: NextAction; featured?: boolean; reason: string; refresh: () => Promise<void>; more?: number; onMore?: () => void }) {
  return <article className={`sf-next-action${featured ? " sf-next-featured" : ""}`}>
    <div className="sf-next-meta"><span>{action.projectName}</span><b>★ {action.stars}</b><span>{action.state === "waiting" ? "等待中" : action.kind === "delivery" ? "交付处理" : action.kind === "clarification" ? "待确认" : "待你处理"}</span></div>
    {featured && <span className="sf-next-kicker">建议现在做</span>}<h3><a className="sf-next-title-link" href={action.href}>{action.title}</a></h3><p className="sf-next-detail">{action.detail}</p>
    <p className="sf-next-reason">{reason}</p>
    <div className="sf-next-action-bottom"><a className={featured ? "primary" : "sf-next-link"} href={action.href}>{action.label}<span aria-hidden="true"> ↗</span></a>{!!more && <button className="sf-text-button" onClick={onMore}>本项目另有 {more} 项</button>}</div>
    <Deadline action={action} refresh={refresh} />
  </article>;
}

export default function NextSteps({ projects, projectId }: { projects: { id: string; name: string; stars?: number }[]; projectId?: string }) {
  const [snapshot, setSnapshot] = useState<NextStepsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"ready" | "waiting" | "urgent">("ready");
  const [expanded, setExpanded] = useState(false), [filter, setFilter] = useState("");
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    try {
      const value = await apiRequest<NextStepsSnapshot>("/api/me/next-steps", { signal: current.signal });
      if (!current.signal.aborted && seq === sequence.current) { setSnapshot(value); setError(""); }
    } catch (e) { if (!current.signal.aborted && seq === sequence.current) setError(e instanceof Error ? e.message : "暂时无法读取待办。"); }
    finally { if (!current.signal.aborted && seq === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const start = window.setTimeout(() => { void refresh(); }, 0);
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, 30000);
    window.addEventListener("focus", visibleRefresh); window.addEventListener("scenarioforge:actions-changed", visibleRefresh);
    return () => { controller.current?.abort(); clearTimeout(start); clearInterval(timer); window.removeEventListener("focus", visibleRefresh); window.removeEventListener("scenarioforge:actions-changed", visibleRefresh); };
  }, [refresh]);
  const now = snapshot ? Date.parse(snapshot.generatedAt) : 0;
  const actions = (snapshot?.actions ?? []).filter(a => projects.some(p => p.id === a.projectId) && (!projectId || a.projectId === projectId)).map(a => ({ ...a, stars: projects.find(p => p.id === a.projectId)?.stars ?? a.stars }));
  const ready = rankActions(actions.filter(a => a.state === "ready"), now), waiting = rankActions(actions.filter(a => a.state === "waiting"), now);
  const urgent = actions.filter(a => a.dueAt && urgency(a, now) <= 1).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
  const selected = (view === "ready" ? ready : view === "waiting" ? waiting : urgent).filter(a => !filter || a.projectId === filter);
  const grouped = [...new Map(selected.map(a => [a.projectId, selected.find(x => x.projectId === a.projectId)!])).values()];
  const displayed = expanded ? selected : grouped.slice(0, 3);
  return <section className={`sf-next-steps${projectId ? " sf-next-compact" : ""}`} aria-label="我的下一步" aria-busy={loading}>
    <header className="sf-next-heading"><div><span className="sf-eyebrow">YOUR NEXT MOVE</span><h2>我的下一步<span>按你的优先级，推进手中的事</span></h2></div><button type="button" className="sf-text-button" onClick={() => void refresh()}>↻ 刷新待办</button></header>
    {error && <p role="alert" className="sf-next-warning">{error} {snapshot ? "以下为上次读取的状态，请刷新后确认。" : ""}</p>}
    {snapshot?.warnings.map(w => <p className="sf-next-warning" role="status" key={w}>{w}</p>)}
    {!!urgent.length && <div className="sf-next-urgent"><span aria-hidden="true">◷</span><div><strong>截止提醒 · {urgent.length} 项</strong><p>优先级由你决定，临近截止的事项单独提醒。</p>{urgent.slice(0, 2).map(a => <a key={`${a.projectId}:${a.id}`} href={a.href}>{a.projectName} · {urgency(a, now) === 0 ? "已逾期" : "24 小时内截止"}{a.state === "waiting" ? " · 等待中" : ""} — {a.title}</a>)}</div><button className="sf-text-button" onClick={() => { setView("urgent"); setExpanded(true); setFilter(""); }}>查看截止提醒</button></div>}
    <div className="sf-next-toolbar"><div role="group" aria-label="待办状态"><button aria-pressed={view === "ready"} onClick={() => setView("ready")}>待我处理 <b>{ready.length}</b></button><button aria-pressed={view === "waiting"} onClick={() => setView("waiting")}>等待中 <b>{waiting.length}</b></button>{view === "urgent" && <button aria-pressed={true}>截止提醒 <b>{urgent.length}</b></button>}</div>{!projectId && <label><span className="sr-only">筛选项目</span><select aria-label="筛选项目" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</div>
    {loading ? <div className="sf-next-empty" role="status">正在整理你的下一步…</div> : error && !snapshot ? <div className="sf-next-empty">待办暂时无法加载，请点击「刷新待办」重试。</div> : !displayed.length ? <div className="sf-next-empty"><span aria-hidden="true">{view === "waiting" ? "◷" : "✓"}</span><h3>{view === "waiting" ? "暂时没有等待中的事项" : view === "urgent" ? "暂时没有临近截止的事项" : "当前没有需要你处理的事项"}</h3><p>{view === "waiting" ? "正在执行或等待他人处理的事项会出现在这里。" : view === "urgent" ? "你设置的截止时间到期前 24 小时，会在这里提醒。" : waiting.length ? "部分事项仍在等待中，就绪后会自动进入待办。" : "可以进入项目开始研究，或为项目设置个人优先级。"}</p></div> : <div className={expanded ? "sf-next-all" : "sf-next-grid"}>{displayed.map((a, i) => <ActionCard key={`${a.projectId}:${a.id}`} action={a} featured={!expanded && i === 0 && view === "ready"} reason={a.state === "ready" ? actionReason(a, now) : "等待条件解除后，会自动进入待办"} refresh={refresh} more={!expanded ? selected.filter(x => x.projectId === a.projectId).length - 1 : 0} onMore={() => { setFilter(a.projectId); setExpanded(true); }} />)}</div>}
    <footer className="sf-next-footer"><p>先按项目星级；同星级再看紧急程度、流程阻塞与等待时间。<br />仅从任务描述识别截止时间；未明确时，可设置个人截止时间。</p>{selected.length > 0 && <button className="sf-text-button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? "收起列表 ↑" : `查看全部 ${selected.length} 项 →`}</button>}</footer>
  </section>;
}
