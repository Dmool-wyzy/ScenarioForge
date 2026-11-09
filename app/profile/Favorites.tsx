"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
type Favorite = { id: string; kind: string; tags: string[]; note: string; createdAt: string; source: null | { title: string; content: string; context: string; href: string; projectId: string } };
const kinds: Record<string, string> = { file: "研究文档", evidence: "证据", message: "个人 Agent 回复", reply: "团队 Agent 回复", research: "研究结论" };
export default function Favorites() {
  const [rows, setRows] = useState<Favorite[] | null>(null), [error, setError] = useState(""), [search, setSearch] = useState(""), [kind, setKind] = useState("");
  const [edit, setEdit] = useState<Favorite | null>(null), [tags, setTags] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void apiRequest<{ favorites: Favorite[] }>("/api/me/favorites").then(result => { if (active) setRows(result.favorites); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  const update = async (remove: boolean, row: Favorite) => {
    setBusy(true); setError("");
    try {
      const details = { tags: [...new Set(tags.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean))], note };
      await apiRequest("/api/me/favorites", { method: remove ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(remove ? { id: row.id } : { id: row.id, ...details }) });
      setRows(current => remove ? current!.filter(item => item.id !== row.id) : current!.map(item => item.id === row.id ? { ...item, ...details } : item)); setEdit(null);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  const filtered = rows?.filter(row => (!kind || row.kind === kind) && `${row.source?.title ?? ""} ${row.source?.content ?? ""} ${row.tags.join(" ")} ${row.note}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="panel sf-profile-panel"><div className="sf-profile-heading"><span className="sf-eyebrow">04 / SAVED FOR LATER</span><h2>我的收藏 <small>{rows?.length ?? 0}</small></h2><p>在文档、证据和 Agent 回复旁点击「收藏」。内容随原文更新，标签和笔记仅自己可见。</p></div>{error && <p role="alert" className="sf-profile-error">{error}</p>}<div className="sf-favorites-filter"><label><span className="sr-only">搜索收藏</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索内容、标签或笔记" /></label><label><span className="sr-only">收藏类型</span><select value={kind} onChange={e => setKind(e.target.value)}><option value="">全部类型</option>{Object.entries(kinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div>
    {!rows ? <p className="sf-profile-empty" role="status">正在读取收藏…</p> : !filtered?.length ? <div className="sf-profile-empty"><span>☆</span><h3>{rows.length ? "没有匹配的收藏" : "把值得再看的内容留在这里"}</h3><p>{rows.length ? "换个关键词或类型试试。" : "进入项目，在文档、证据或 Agent 回复旁点击收藏。"}</p><Link href="/">返回项目主页 →</Link></div> : <ul className="sf-favorites-list">{filtered.map(row => <li key={row.id}><div className="sf-favorite-meta"><span>{kinds[row.kind]}</span><time>{new Date(row.createdAt).toLocaleDateString("zh-CN")}</time></div>{row.source ? <><h3><a href={row.source.href}>{row.source.title} ↗</a></h3><small>{row.source.context}</small><details><summary>查看收藏内容</summary><p className="sf-favorite-content">{row.source.content}{row.source.content.length >= 1500 ? "…" : ""}</p></details></> : <><h3>原内容已不可访问</h3><p>内容可能已删除，或你已不在原项目中。</p></>}<div className="sf-favorite-tags">{row.tags.map(t => <span key={t}>{t}</span>)}</div>{row.note && <p className="sf-favorite-note">我的笔记：{row.note}</p>}{edit?.id === row.id ? <form onSubmit={e => { e.preventDefault(); void update(false, row); }}><label>标签<input aria-label="标签" value={tags} maxLength={280} onChange={e => setTags(e.target.value)} placeholder="用顿号分隔，最多 8 个，每个 30 字" /></label><label>个人笔记<textarea aria-label="个人笔记" rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label><div className="sf-profile-actions"><button className="primary" disabled={busy}>保存收藏信息</button><button type="button" className="secondary" disabled={busy} onClick={() => setEdit(null)}>取消</button></div></form> : <div className="sf-favorite-actions"><button className="sf-text-button" disabled={busy} onClick={() => { setEdit(row); setTags(row.tags.join("、")); setNote(row.note); }}>编辑标签与笔记</button><button className="sf-text-button" disabled={busy} onClick={() => void update(true, row)}>取消收藏</button></div>}</li>)}</ul>}
  </section>;
}
