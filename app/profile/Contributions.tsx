"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import { CONTRIBUTION_LEVELS, CONTRIBUTION_RULES, type ContributionKind } from "@/lib/contribution-levels";
import LevelCard from "./LevelCard";

type RecordRow = { id: string; kind: ContributionKind; title: string; points: number; note: string; revokeReason: string; revokedAt: string | null; createdAt: string; projectName: string; href: string | null };
type Collection = { summary: { experience: number; counts: Record<string, number> }; total: number; page: number; projects: { id: string; name: string; role: string }[]; records: RecordRow[] };
type Candidate = { kind: "task" | "knowledge" | "milestone"; targetId: string; title: string; content: string; author: string; href: string; recognized: boolean; recordId: string | null; note: string; eligible: boolean };

export default function Contributions({ onExperience }: { onExperience: (value: number) => void }) {
  const [data, setData] = useState<Collection | null>(null), [project, setProject] = useState(""), [page, setPage] = useState(1);
  const [mode, setMode] = useState("history"), [reviewProject, setReviewProject] = useState("");
  const [review, setReview] = useState<{ candidates: Candidate[]; limited: boolean } | null>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<{ candidate: Candidate; action: "confirm" | "revoke" } | null>(null), [note, setNote] = useState("");
  const [preview, setPreview] = useState<number | null>(null);
  const refresh = useCallback(() => { setLoading(true); setReview(null); setError(""); setRevision(value => value + 1); }, []);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ page: String(page) }); if (project) query.set("project", project);
    void apiRequest<Collection>(`/api/me/contributions?${query}`).then(value => { if (active) { setData(value); onExperience(value.summary.experience); setReviewProject(current => current || value.projects.find(p => p.role === "owner")?.id || ""); } }).catch(e => { if (active) setError(e instanceof Error ? e.message : "贡献记录加载失败。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project, page, revision, onExperience]);
  useEffect(() => {
    if (mode !== "review" || !reviewProject) return;
    let active = true;
    void apiRequest<{ candidates: Candidate[]; limited: boolean }>(`/api/me/contributions?view=review&project=${encodeURIComponent(reviewProject)}`).then(value => { if (active) setReview(value); }).catch(e => { if (active) setError(e instanceof Error ? e.message : "审核列表加载失败。"); });
    return () => { active = false; };
  }, [mode, reviewProject, revision]);
  const submit = async () => {
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const candidate = selected.candidate;
      await apiRequest("/api/me/contributions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: selected.action, projectId: reviewProject, note, ...(selected.action === "confirm" ? { kind: candidate.kind, targetId: candidate.targetId } : { recordId: candidate.recordId }) }) });
      setMessage(selected.action === "confirm" ? "贡献已认可，经验已更新；重复确认不会重复计分。" : "认定已撤销，相关经验已回退。");
      setSelected(null); setNote(""); refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  const owners = data?.projects.filter(p => p.role === "owner") ?? [];
  return <div className="sf-contributions">
    <div className="sf-profile-heading"><span className="sf-eyebrow">YOUR CONTRIBUTIONS</span><h2>贡献记录</h2><p>每一份被认可的投入，都是你的成长。等级按所有项目累计经验计算。</p></div>
    {error && <div role="alert" className="sf-profile-error">{error}<button className="secondary" onClick={refresh}>重新加载</button></div>}
    {message && <p role="status" className="sf-profile-success">{message}</p>}
    {data && <><div className="sf-contribution-stats">{Object.entries(CONTRIBUTION_RULES).map(([kind, rule]) => <div key={kind}><strong>{data.summary.counts[kind] ?? 0}</strong><span>{rule.label}</span></div>)}</div>
      <details className="sf-level-guide panel"><summary>成长规则与等级图鉴 <span>7 个等级 · 最高 9,999 EXP</span></summary><p>登录、聊天和模型调用不计分。贡献须经项目创建者确认；审核自己的成果不额外获得审查经验。撤销认定会回退经验，等级随之调整。</p>
        <div className="sf-growth-rules">{Object.entries(CONTRIBUTION_RULES).map(([kind, rule]) => <div key={kind}><strong>{rule.label}<b>+{rule.points}</b></strong><p>{rule.description}</p></div>)}</div>
        <p>第一版将每个已完成的研究包作为一个项目里程碑。先认可阶段内的交付或成果，再确认里程碑；新补认的成员可再次确认补发，已有成员不会重复得分。</p>
        <div className="sf-level-picker" aria-label="等级样式预览">{CONTRIBUTION_LEVELS.map(level => <button key={level.level} type="button" aria-pressed={preview === level.level} onClick={() => setPreview(level.level)}><span>Lv.{level.level} {level.name}</span><small>{level.threshold.toLocaleString("zh-CN")} EXP</small></button>)}</div>
        {preview !== null && <><p className="sf-level-preview-hint">样式预览 · 不会改变你的实际等级或经验</p><LevelCard experience={CONTRIBUTION_LEVELS[preview - 1].threshold} preview /></>}
      </details>
      <section className="panel sf-profile-panel"><div className="sf-contribution-tabs"><button type="button" aria-pressed={mode === "history"} onClick={() => { setMode("history"); setSelected(null); }}>我的记录</button>{owners.length > 0 && <button type="button" aria-pressed={mode === "review"} onClick={() => { if (mode !== "review") { setReview(null); setError(""); setMode("review"); } }}>项目贡献审核</button>}</div>
      {mode === "history" ? <><label className="sf-contribution-filter">按项目查看<select aria-label="筛选贡献项目" value={project} onChange={e => { setLoading(true); setError(""); setProject(e.target.value); setPage(1); }}>{<option value="">全部项目</option>}{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {loading ? <p role="status" className="sf-profile-empty">正在读取贡献记录…</p> : data.records.length ? <ol className="sf-contribution-timeline">{data.records.map(record => <li key={record.id} className={record.revokedAt ? "is-revoked" : ""}><span className="sf-contribution-dot" aria-hidden="true" /><div className="sf-contribution-meta"><span>{CONTRIBUTION_RULES[record.kind]?.label} · {record.projectName}</span><b>{record.revokedAt ? "已撤销" : `+${record.points} EXP`}</b></div><h3>{record.href ? <Link href={record.href}>{record.title} ↗</Link> : record.title}</h3><p>{record.note}</p>{record.revokedAt && <p className="sf-contribution-revoked">经验已回退 · {record.revokeReason || "认定已撤销"}</p>}<time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString("zh-CN")}</time></li>)}</ol> : <div className="sf-profile-empty"><span aria-hidden="true">✧</span><h3>你的贡献，从第一次认可开始</h3><p>完成任务或分享成果后，请项目创建者在「项目贡献审核」中确认。</p><Link href="/">返回项目，开始参与 →</Link></div>}
        {data.total > 20 && <div className="sf-contribution-pagination"><button className="secondary" disabled={page <= 1 || loading} onClick={() => { setLoading(true); setPage(p => p - 1); }}>上一页</button><span>第 {page} / {Math.ceil(data.total / 20)} 页</span><button className="secondary" disabled={page * 20 >= data.total || loading} onClick={() => { setLoading(true); setPage(p => p + 1); }}>下一页</button></div>}
      </> : <><p className="sf-contribution-help">检查原始交付并记录审核理由后确认。任务与其 Git 存入、合并共用一次交付贡献；共享知识库条目仅用于独立成果，请勿重复认可同一份内容。</p><label className="sf-contribution-filter">管理的项目<select aria-label="选择贡献审核项目" disabled={busy} value={reviewProject} onChange={e => { setReview(null); setSelected(null); setError(""); setReviewProject(e.target.value); }}>{owners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {!review ? <p role="status" className="sf-profile-empty">正在读取可审核贡献…</p> : review.candidates.length ? <div className="sf-contribution-review-list">{review.candidates.map(candidate => <article key={`${candidate.kind}:${candidate.targetId}`}><div className="sf-contribution-meta"><span>{CONTRIBUTION_RULES[candidate.kind].label} · {candidate.author}</span><b>{candidate.recognized ? "已认可" : `+${CONTRIBUTION_RULES[candidate.kind].points} EXP`}</b></div><h3>{candidate.title}</h3><details><summary>检查交付内容</summary><p className="sf-contribution-source">{candidate.content}</p><Link href={candidate.href}>查看原始位置 ↗</Link></details>{candidate.note && <p className="sf-contribution-note">上次认定：{candidate.note}</p>}{!candidate.eligible && <p className="sf-contribution-note">此来源暂不符合认可条件：请检查来源状态，或先认可阶段内的交付与成果。</p>}<div className="sf-contribution-review-actions">{(!candidate.recognized || candidate.kind === "milestone") && <button className="secondary" disabled={busy || !candidate.eligible} onClick={() => { setSelected({ candidate, action: "confirm" }); setNote(""); setMessage(""); }}>{candidate.kind === "milestone" ? candidate.recognized ? "补认里程碑成员" : "确认里程碑" : "审核并认可"}</button>}{candidate.recognized && <button disabled={busy} onClick={() => { setSelected({ candidate, action: "revoke" }); setNote(""); setMessage(""); }}>撤销认定</button>}</div>
          {selected?.candidate.targetId === candidate.targetId && selected.candidate.kind === candidate.kind && <form className="sf-contribution-confirm" onSubmit={e => { e.preventDefault(); void submit(); }}><label>{selected.action === "confirm" ? "检查内容与认可理由" : "撤销原因"}<textarea autoFocus rows={3} value={note} maxLength={600} minLength={selected.action === "confirm" ? 10 : 5} required disabled={busy} onChange={e => setNote(e.target.value)} placeholder={selected.action === "confirm" ? "请具体说明检查了什么、符合哪些要求（至少 10 个字）" : "填写撤销原因，相关经验将一并回退"} /></label>{selected.action === "revoke" && <p>任务或成果的审查经验会同步回退；若成员不再有本阶段的有效交付或成果，里程碑经验也会回退。撤销里程碑会回退该里程碑所有成员的奖励。</p>}<button className="primary" disabled={busy}>{busy ? "处理中…" : selected.action === "confirm" ? "确认认可贡献" : "确认撤销认定"}</button><button type="button" className="secondary" disabled={busy} onClick={() => setSelected(null)}>取消</button></form>}
        </article>)}</div> : <p className="sf-profile-empty">暂时没有可审核贡献。成员提交任务、分享证据到团队知识库或完成研究后，会在这里出现。</p>}{review?.limited && <p className="sf-contribution-help">当前展示各类最新 100 项来源。</p>}
      </>}
      </section>
    </>}
    {!data && !error && <p role="status" className="sf-profile-empty">正在加载成长记录…</p>}
  </div>;
}
