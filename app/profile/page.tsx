"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import AvatarIcon from "../components/AvatarIcon";
import { avatarFromFile } from "./avatar-image";
import { apiRequest } from "@/hooks/useResearch";
import PersonalAgent from "../components/PersonalAgent";
import Favorites from "./Favorites";
import Security from "./Security";
import Contributions from "./Contributions";
import LevelCard from "./LevelCard";
import "./profile.css";

const avatars = { leaf: "❧", sun: "☀", moon: "☾", mountain: "△", wave: "≈", star: "✦" };
const avatarNames = { leaf: "绿叶", sun: "暖阳", moon: "月亮", mountain: "山峰", wave: "海浪", star: "星星" };
type Profile = { nickname: string; avatar: string; bio: string; specialty: string; skills: string[]; agentStyle: string; agentTech: string; agentDelivery: string; agentNotes: string };
type Snapshot = { user: { username: string; createdAt: string }; profile: Profile; projects: { id: string; name: string }[]; growth?: { experience: number } };
const tabs = [{ id: "profile", label: "个人资料", icon: "◉", detail: "介绍你自己" }, { id: "contributions", label: "贡献记录", icon: "♧", detail: "记录贡献与等级成长" }, { id: "agent", label: "个人 Agent", icon: "✦", detail: "配置与工作偏好" }, { id: "security", label: "账号安全", icon: "◇", detail: "密码与登录设备" }, { id: "favorites", label: "我的收藏", icon: "☆", detail: "保存值得再看的内容" }];
export default function PersonalCenterPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [draft, setDraft] = useState<Profile | null>(null);
  const [tab, setTab] = useState("profile"), [project, setProject] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [skills, setSkills] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  const [processingAvatar, setProcessingAvatar] = useState(false);
  const [experience, setExperience] = useState(0);
  const selectAvatar = async (file?: File) => {
    if (!file) return;
    setProcessingAvatar(true); setError(""); setMessage("");
    try { const avatar = await avatarFromFile(file); setDraft(current => current ? { ...current, avatar } : current); }
    catch (e) { setError(e instanceof Error ? e.message : "图片读取失败，请重试。"); }
    finally { setProcessingAvatar(false); if (avatarInput.current) avatarInput.current.value = ""; }
  };
  useEffect(() => {
    let active = true;
    const readLocation = () => { const q = new URLSearchParams(window.location.search); setTab(tabs.some(t => t.id === q.get("tab")) ? q.get("tab")! : "profile"); };
    readLocation(); window.addEventListener("popstate", readLocation);
    void (async () => {
      try {
        const auth = await apiRequest<{ user: unknown }>("/api/auth/me");
        if (!auth.user) { window.location.replace("/"); return; }
        const value = await apiRequest<Snapshot>("/api/me/profile");
        if (!active) return;
        setSnapshot(value); setDraft(value.profile); setSkills(value.profile.skills.join("、")); setExperience(value.growth?.experience ?? 0);
        const requested = new URLSearchParams(window.location.search).get("project");
        setProject(value.projects.find(p => p.id === requested)?.id ?? value.projects[0]?.id ?? "");
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "个人中心加载失败。"); }
    })();
    return () => { active = false; window.removeEventListener("popstate", readLocation); };
  }, []);
  const choose = (id: string) => { setTab(id); setMessage(""); setError(""); const q = new URLSearchParams({ tab: id }); if (project && id === "agent") q.set("project", project); window.history.pushState({}, "", `/profile?${q}`); };
  const save = async (agent: boolean) => {
    if (!draft || !snapshot) return;
    setBusy(true); setMessage(""); setError("");
    const nextSkills = [...new Set(skills.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean))];
    const data = agent ? { agentStyle: draft.agentStyle, agentTech: draft.agentTech, agentDelivery: draft.agentDelivery, agentNotes: draft.agentNotes } : { nickname: draft.nickname, avatar: draft.avatar, bio: draft.bio, specialty: draft.specialty, skills: nextSkills };
    try {
      const result = await apiRequest<{ avatar?: string }>(`/api/me/${agent ? "agent-preferences" : "profile"}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const saved = { ...data, ...(!agent && result.avatar ? { avatar: result.avatar } : {}) };
      setSnapshot({ ...snapshot, profile: { ...snapshot.profile, ...saved } });
      if (!agent && result.avatar) setDraft(current => current ? { ...current, avatar: result.avatar! } : current);
      setMessage(agent ? "工作偏好已保存，从下一次个人 Agent 调用开始生效。" : "个人资料已保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败。"); }
    finally { setBusy(false); }
  };
  return <main className="sf-profile-shell">
    <header className="sf-profile-header"><Link href="/" className="sf-profile-brand"><span className="sf-brand-mark">S<span>↗</span></span><span>ScenarioForge<small>先研究，再创作</small></span></Link><Link href="/" className="secondary">← 返回项目主页</Link></header>
    {!snapshot || !draft ? <section className="panel sf-profile-loading"><h1>个人中心</h1>{error ? <><p role="alert">{error}</p><button className="secondary" onClick={() => window.location.reload()}>重新加载</button></> : <p role="status">正在加载个人资料…</p>}</section> : <>
      <section className="sf-profile-hero"><div className={`sf-profile-avatar ${snapshot.profile.avatar.startsWith("data:") ? "avatar-custom" : `avatar-${snapshot.profile.avatar}`}`}><AvatarIcon value={snapshot.profile.avatar} /></div><div><span className="sf-eyebrow">YOUR PERSONAL SPACE</span><h1>{snapshot.profile.nickname || snapshot.user.username}<span>的个人中心</span></h1><p>{snapshot.profile.bio || "管理你的资料、工作习惯和个人积累。"}</p></div><div className="sf-profile-stat"><strong>{snapshot.projects.length}</strong><span>参与的项目</span></div></section>
      <div className="sf-profile-layout"><nav className="sf-profile-nav" aria-label="个人中心导航">{tabs.map(t => <button key={t.id} type="button" aria-label={t.label} aria-current={tab === t.id ? "page" : undefined} onClick={() => choose(t.id)}><span aria-hidden="true">{t.icon}</span><span><strong>{t.label}</strong><small>{t.detail}</small></span><b aria-hidden="true">↗</b></button>)}</nav>
        <div className="sf-profile-content">{error && <p role="alert" className="sf-profile-error">{error}</p>}{message && <p role="status" className="sf-profile-success">{message}</p>}
          {(tab === "profile" || tab === "contributions") && <LevelCard experience={experience} onOpen={tab === "profile" ? () => choose("contributions") : undefined} />}
          {tab === "contributions" && <Contributions onExperience={setExperience} />}
          {tab === "profile" && <section className="panel sf-profile-panel"><div className="sf-profile-heading"><span className="sf-eyebrow">01 / ABOUT YOU</span><h2>个人资料</h2><p>完善专业方向和技能，个人 Agent 可参考这些信息调整建议。</p></div>
            <form onSubmit={e => { e.preventDefault(); void save(false); }}><fieldset disabled={busy || processingAvatar}><legend>选择头像</legend><div className="sf-avatar-options">{(Object.keys(avatars) as (keyof typeof avatars)[]).map(key => <button key={key} type="button" aria-label={`${avatarNames[key]}头像`} aria-pressed={draft.avatar === key} className={`avatar-${key}`} onClick={() => setDraft({ ...draft, avatar: key })}>{avatars[key]}</button>)}<button type="button" className="sf-avatar-upload" aria-label="选择本地头像" aria-pressed={draft.avatar.startsWith("data:")} onClick={() => avatarInput.current?.click()}>{draft.avatar.startsWith("data:") ? <AvatarIcon value={draft.avatar} alt="待保存的头像预览" /> : <span aria-hidden="true">＋</span>}<small>{processingAvatar ? "处理中" : draft.avatar.startsWith("data:") ? "更换图片" : "上传头像"}</small></button><input hidden ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="本地头像文件" onChange={e => void selectAvatar(e.target.files?.[0])} /></div><p className="sf-avatar-help">JPG、PNG 或 WebP，最大 5 MB。图片会居中裁为正方形，点击「保存资料」后生效。</p>
              <div className="sf-profile-fields"><label>昵称<input value={draft.nickname} maxLength={40} placeholder={snapshot.user.username} onChange={e => setDraft({ ...draft, nickname: e.target.value })} /></label><label>登录账号<input value={snapshot.user.username} readOnly /><small>账号用于登录，昵称用于展示。</small></label><label className="sf-profile-wide">个人简介<textarea value={draft.bio} maxLength={500} rows={3} onChange={e => setDraft({ ...draft, bio: e.target.value })} placeholder="简单介绍你自己，以及正在关注的方向" /></label><label className="sf-profile-wide">专业方向<input value={draft.specialty} maxLength={100} onChange={e => setDraft({ ...draft, specialty: e.target.value })} placeholder="例如：软件工程 / 产品设计 / 数据分析" /></label><label className="sf-profile-wide">技能标签<input value={skills} maxLength={500} onChange={e => setSkills(e.target.value)} placeholder="React、Python、文献调研" /><small>用逗号或顿号分隔，最多 12 个，每个不超过 30 字。</small></label></div>
              <div className="sf-profile-actions"><button className="primary">{busy ? "保存中…" : "保存资料"}</button><span>加入于 {new Date(snapshot.user.createdAt).toLocaleDateString("zh-CN")}</span></div>
            </fieldset></form></section>}
          {tab === "agent" && <><section className="panel sf-profile-panel"><div className="sf-profile-heading"><span className="sf-eyebrow">02 / YOUR AGENT</span><h2>个人 Agent</h2><p>跨项目使用同一份工作偏好；具体任务和本轮补充要求优先。</p></div><form onSubmit={e => { e.preventDefault(); void save(true); }}><fieldset disabled={busy}><div className="sf-profile-fields"><label className="sf-profile-wide">回答风格<select value={draft.agentStyle} onChange={e => setDraft({ ...draft, agentStyle: e.target.value })}><option value="concise">简洁 · 先给结论与操作步骤</option><option value="balanced">适中 · 结论与必要解释</option><option value="detailed">详细 · 展开分析与示例</option></select></label><label>技术偏好<textarea rows={3} maxLength={500} value={draft.agentTech} onChange={e => setDraft({ ...draft, agentTech: e.target.value })} placeholder="例如：前端优先使用 React + TypeScript" /></label><label>交付格式<textarea rows={3} maxLength={500} value={draft.agentDelivery} onChange={e => setDraft({ ...draft, agentDelivery: e.target.value })} placeholder="例如：代码附运行方法，方案附验收步骤" /></label><label className="sf-profile-wide">其他工作习惯<textarea rows={3} maxLength={1000} value={draft.agentNotes} onChange={e => setDraft({ ...draft, agentNotes: e.target.value })} placeholder="例如：遇到信息缺口先列出假设，用中文解释" /></label></div><div className="sf-profile-actions"><button className="primary">{busy ? "保存中…" : "保存工作偏好"}</button><span>偏好仅用于你的个人 Agent</span></div></fieldset></form></section>
            <section className="sf-profile-model"><div className="sf-profile-heading"><h2>项目中的模型配置</h2><p>选择项目管理个人模型与接收权限，已有配置会直接显示。</p></div>{snapshot.projects.length ? <><label>选择项目<select aria-label="选择项目" value={project} onChange={e => setProject(e.target.value)}>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><PersonalAgent key={project} projectId={project} mode="settings" /></> : <p className="sf-profile-empty">创建或加入项目后，可在这里配置个人模型。<Link href="/">返回主页 →</Link></p>}</section></>}
          {tab === "security" && <Security />}
          {tab === "favorites" && <Favorites />}
        </div>
      </div><footer className="sf-profile-footer">ScenarioForge · 让工作积累成为下一次的起点</footer>
    </>}
  </main>;
}
