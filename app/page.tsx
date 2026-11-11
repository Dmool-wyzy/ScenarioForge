"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import AvatarIcon from "./components/AvatarIcon";
import NextSteps from "./components/NextSteps";
import ProjectPriority from "./components/ProjectPriority";
import { useActionTarget } from "@/hooks/useActionTarget";
import Workspace from "./components/Workspace";
import ModelSettings from "./components/ModelSettings";
import ProjectKnowledgePanel from "./components/ProjectKnowledgePanel";
import PersonalAgent from "./components/PersonalAgent";
import ProjectRepository from "./components/ProjectRepository";

type User = { id: string; username: string; nickname?: string; avatar?: string };
type Project = {
  stars?: number; sortOrder?: number; createdAt?: string;
  id: string;
  name: string;
  inviteCode: string;
  role: string;
  memberCount: number;
  researchPackages: { id: string; title: string; status: string; updatedAt: string }[];
};

function Brand({ light = false }: { light?: boolean }) {
  return <div className={`sf-brand${light ? " sf-brand-light" : ""}`}><span className="sf-brand-mark" aria-hidden="true">S<span>↗</span></span><span>ScenarioForge<small>先研究，再创作</small></span></div>;
}

function Folder({ large = false }: { large?: boolean }) {
  return <svg className={large ? "sf-folder sf-folder-large" : "sf-folder"} width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M3 10h18M9 15h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

function AccountForm({ onAuthenticated }: { onAuthenticated: (user: User) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  return <div className="sf-auth-shell">
    <section className="sf-auth-story">
      <Brand light />
      <div className="sf-auth-copy"><span className="sf-eyebrow sf-eyebrow-light"><i /> 为有想法的团队而建</span><h1>让每一个计划，<br />都有据可依。</h1><p>从目标到证据，从灵感到行动。<br />在同一个项目里，和团队一起积累、研究、创造。</p>
        <div className="sf-research-map" aria-label="项目研究流程示意"><div className="sf-map-header"><span className="sf-map-dot" /> YOUR NEXT PROJECT <span>↗</span></div><div className="sf-map-note"><span>01</span><div><strong>定义一个目标</strong><small>想法、约束与参考资料</small></div><b>＋</b></div><div className="sf-map-line" /><div className="sf-map-note"><span>02</span><div><strong>汇集可靠证据</strong><small>研究、知识库与可追溯引用</small></div><b>◇</b></div><div className="sf-map-line" /><div className="sf-map-note sf-map-note-last"><span>03</span><div><strong>共建项目工作区</strong><small>共享上下文，推进下一步</small></div><b>↗</b></div></div>
      </div>
      <p className="sf-story-footer">好的研究，让团队走得更远。<span>SCENARIOFORGE / WORKSPACE</span></p>
    </section>
    <section className="sf-auth-side"><div className="sf-auth-card">
      <div className="sf-auth-switch" aria-label="选择登录或注册">{([['login', '登录'], ['register', '注册账号']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? "is-active" : ""} disabled={busy} onClick={() => { setMode(value); setError(""); }}>{label}</button>)}</div>
      <div className="sf-auth-heading"><span className="sf-eyebrow">YOUR RESEARCH STARTS HERE</span><h2>{mode === "login" ? "欢迎回来" : "开启你的研究空间"}<span>↗</span></h2><p>{mode === "login" ? "登录账号，继续你和团队的项目。" : "创建账号后，即可创建项目或凭邀请码加入团队。"}</p></div>
      <form key={mode} className="sf-account-form" onSubmit={async event => {
        event.preventDefault(); setError("");
        const data = new FormData(event.currentTarget);
        const username = String(data.get("username") ?? "").trim();
        const password = String(data.get("password") ?? "");
        if (mode === "register" && password !== data.get("confirmPassword")) { setError("两次输入的密码不一致，请重新确认。"); return; }
        setBusy(true);
        try {
          const result = await apiRequest<{ user: User }>(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
          await onAuthenticated(result.user);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法登录，请稍后重试。"); }
        finally { setBusy(false); }
      }}>
        <label htmlFor="account-username">用户名<input id="account-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" title="请输入3至32位字母、数字或下划线" placeholder="请输入用户名" disabled={busy} aria-describedby="username-help" /></label>
        <p id="username-help" className="sf-field-help">3–32 位字母、数字或下划线</p>
        <label htmlFor="account-password">密码<span className="sf-password-input"><input id="account-password" name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={128} placeholder={mode === "login" ? "请输入密码" : "设置至少 8 位密码"} disabled={busy} /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button></span></label>
        {mode === "register" && <label htmlFor="account-confirm-password">确认密码<input id="account-confirm-password" name="confirmPassword" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={8} maxLength={128} placeholder="再次输入密码" disabled={busy} /></label>}
        {error && <p role="alert" className="sf-form-error">{error}</p>}
        <button className="primary sf-auth-submit" disabled={busy}>{busy ? "正在进入工作空间…" : mode === "login" ? "登录工作空间" : "创建账号并进入"}<span aria-hidden="true">→</span></button>
      </form>
      <div className="sf-auth-bottom"><span aria-hidden="true">◇</span> 资料以项目为边界，协作从登录开始。</div>
    </div><p className="sf-auth-copyright">ScenarioForge · 从想法到行动</p></section>
  </div>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [initialPackageId, setInitialPackageId] = useState<string | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [pending, setPending] = useState<"create" | "join" | "logout" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  useEffect(() => {
    let active = true;
    const readLocation = () => {
      const url = new URL(window.location.href);
      setProjectId(url.searchParams.get("project"));
      setInitialPackageId(url.searchParams.get("package"));
      setCopied(false); setCopyError("");
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    void (async () => {
      try {
        const auth = await apiRequest<{ user: User | null }>("/api/auth/me");
        if (!active) return;
        setUser(auth.user);
        if (auth.user) {
          const result = await apiRequest<{ projects: Project[] }>("/api/projects");
          if (active) setProjects(result.projects);
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "工作空间暂时无法加载。"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; window.removeEventListener("popstate", readLocation); };
  }, []);

  const [priorityBusy, setPriorityBusy] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  useActionTarget(`${projectId}:${initialPackageId}`);
  const sortedProjects = [...projects].sort((a, b) => (b.stars ?? 3) - (a.stars ?? 3) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id) || a.id.localeCompare(b.id));
  const savePriority = async (id: string, stars: number) => {
    setPriorityBusy(id); setError("");
    try { await apiRequest(`/api/projects/${id}/my-priority`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stars }) }); setProjects(rows => rows.map(p => p.id === id ? { ...p, stars } : p)); }
    catch (e) { setError(e instanceof Error ? e.message : "优先级保存失败。"); }
    finally { setPriorityBusy(null); }
  };
  const reorder = async (from: string, to: string) => {
    const item = projects.find(p => p.id === from), target = projects.find(p => p.id === to);
    if (!item || !target || from === to || (item.stars ?? 3) !== (target.stars ?? 3)) return;
    const ids = sortedProjects.filter(p => (p.stars ?? 3) === (item.stars ?? 3)).map(p => p.id);
    const destination = ids.indexOf(to); ids.splice(ids.indexOf(from), 1); ids.splice(destination, 0, from);
    setPriorityBusy(from); setError("");
    try { await apiRequest("/api/me/project-order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stars: item.stars ?? 3, projectIds: ids }) }); setProjects(rows => rows.map(p => ids.includes(p.id) ? { ...p, sortOrder: ids.indexOf(p.id) } : p)); }
    catch (e) { setError(e instanceof Error ? e.message : "顺序保存失败。"); }
    finally { setPriorityBusy(null); }
  };
  useEffect(() => {
    if (!user) return;
    let active = true;
    const sync = () => { void apiRequest<{ projects: Project[] }>("/api/projects").then(result => { if (active) setProjects(result.projects); }).catch(() => {}); };
    window.addEventListener("focus", sync);
    return () => { active = false; window.removeEventListener("focus", sync); };
  }, [user]);
  const project = projects.find(item => item.id === projectId);
  const refreshProjects = async () => {
    setProjectsLoading(true);
    try { const result = await apiRequest<{ projects: Project[] }>("/api/projects"); setProjects(result.projects); }
    finally { setProjectsLoading(false); }
  };
  const navigate = (id: string | null, packageId: string | null = null) => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("workspace");
    if (id) url.searchParams.set("project", id); else url.searchParams.delete("project");
    if (packageId) url.searchParams.set("package", packageId); else url.searchParams.delete("package");
    window.history.pushState(null, "", url);
    setProjectId(id); setInitialPackageId(packageId); setWorkspaceRevision(value => value + 1); setCopied(false); setCopyError(""); setError("");
  };
  const onAuthenticated = async (account: User) => {
    const result = await apiRequest<{ projects: Project[] }>("/api/projects");
    setProjects(result.projects); setUser(account); setError("");
  };
  const mutateProject = async (kind: "create" | "join", data: { name: string } | { inviteCode: string }) => {
    setPending(kind); setError("");
    try {
      const result = await apiRequest<{ project: Project }>(kind === "create" ? "/api/projects" : "/api/projects/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      setProjects(items => [result.project, ...items.filter(item => item.id !== result.project.id)]);
      setInviteCode(""); navigate(result.project.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目操作失败，请稍后重试。"); }
    finally { setPending(null); }
  };
  const logOut = async () => {
    setPending("logout"); setError("");
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
      setUser(null); setProjects([]); navigate(null);
      localStorage.removeItem("scenarioforge:last-package");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "退出失败，请重试。"); }
    finally { setPending(null); }
  };
  const errorBanner = error && <div role="alert" className="sf-error-banner"><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}>×</button></div>;

  if (loading) return <main className="sf-loading" aria-busy="true"><Brand /><span className="sf-loading-line" /><p>正在打开你的工作空间…</p></main>;
  if (!user) return <main>{errorBanner && <div className="sf-auth-service-error">{errorBanner}</div>}<AccountForm onAuthenticated={onAuthenticated} /></main>;

  return <main className="sf-app">
    <header className="sf-app-header"><Brand /><span className="sf-header-divider" /><span className="sf-header-location">{project ? "项目工作区" : "我的项目"}</span><div className="sf-user-menu"><a href="/profile" className="sf-account-link" aria-label="打开个人中心"><span className="sf-avatar" aria-hidden="true"><AvatarIcon value={user.avatar} /></span><span className="sf-username">{user.nickname || user.username} · 个人中心</span></a><button type="button" className="sf-text-button" disabled={pending === "logout"} onClick={() => void logOut()}>{pending === "logout" ? "正在退出…" : "退出登录"}</button></div></header>
    <div className={`sf-app-content${project ? " sf-workspace-content" : ""}`}>{errorBanner}
      {project ? <>
        <section className="sf-project-top"><div><button type="button" className="sf-back-button" onClick={() => { navigate(null); void refreshProjects().catch(cause => setError(cause instanceof Error ? cause.message : "无法刷新项目。")); }}>← 返回项目</button><div className="sf-project-title"><div className="sf-project-symbol"><Folder /></div><div><h1>{project.name}</h1><p>{project.role === "owner" ? "项目创建者" : "项目成员"}<span>·</span>{project.memberCount} 位成员<span>·</span>共享研究与知识</p></div></div></div><div className="sf-invitation"><span>邀请伙伴加入</span><div><strong className="sf-invite-code">{project.inviteCode}</strong><button type="button" className="secondary" aria-label="复制邀请码" onClick={async () => { try { await navigator.clipboard.writeText(project.inviteCode); setCopied(true); setCopyError(""); } catch { setCopyError("请选中邀请码，手动复制后分享给伙伴。"); } }}>{copied ? "已复制 ✓" : "复制邀请码"}</button></div><small aria-live="polite">{copyError || "对方登录后输入邀请码，即可加入本项目"}</small></div></section>
        <ModelSettings key={project.id} projectId={project.id} isOwner={project.role === "owner"} />
        <PersonalAgent key={project.id + ":personal-agent"} projectId={project.id} />
        <ProjectRepository key={project.id + ":repository"} projectId={project.id} projectName={project.name} isOwner={project.role === "owner"} />
        <ProjectKnowledgePanel key={project.id + ":knowledge"} projectId={project.id} />
        <nav className="sf-research-nav" aria-label="选择项目对话和任务"><button type="button" className={!initialPackageId ? "is-active" : ""} onClick={() => navigate(project.id)}>＋ 新对话/任务</button>{project.researchPackages.map(research => <button type="button" className={initialPackageId === research.id ? "is-active" : ""} key={research.id} title={research.title} onClick={() => navigate(project.id, research.id)}>{research.title}</button>)}<button type="button" className="sf-refresh-project" disabled={projectsLoading} onClick={() => void refreshProjects().catch(cause => setError(cause instanceof Error ? cause.message : "无法刷新任务记录。"))}>{projectsLoading ? "刷新中…" : "↻ 刷新记录"}</button></nav>
        <Workspace key={`${project.id}:${initialPackageId ?? "new"}:${workspaceRevision}`} projectId={project.id} projectName={project.name} initialPackageId={project.researchPackages.some(item => item.id === initialPackageId) ? initialPackageId : null} />
      </> : <>
        <section className="sf-hall-hero"><div><span className="sf-eyebrow"><i /> YOUR PROJECTS, IN ONE PLACE</span><h1>把想法汇聚，<br className="sf-mobile-break" />让研究发生<span>。</span></h1><p>欢迎回来，{user.nickname || user.username}。创建一个新项目，或加入伙伴的工作空间。</p></div><div className="sf-hero-stamp" aria-hidden="true"><span>每一步，都有迹可循</span><b>想法 <i>→</i> 证据 <i>→</i> 行动</b></div></section>
        {projectId && !project && <p role="status" className="sf-notice">该项目不存在，或你尚未加入。你可以使用邀请码加入项目。</p>}
        <NextSteps key={user.id} projects={sortedProjects} />
        <div className="sf-hall-grid"><section className="sf-projects-section"><div className="sf-section-heading"><div><h2>我的项目 <span>{projects.length.toString().padStart(2, "0")}</span></h2><p>5 星最高，仅影响你自己；同星级可拖动 ⋮⋮ 或用箭头调整顺序。</p></div><button type="button" className="sf-text-button" disabled={projectsLoading} onClick={() => void refreshProjects().catch(cause => setError(cause instanceof Error ? cause.message : "无法刷新项目。"))}>{projectsLoading ? "刷新中…" : "↻ 刷新"}</button></div>
          {projects.length ? <div className="sf-project-grid">{sortedProjects.map((item, index) => <article className={`sf-project-card sf-card-tone-${index % 3}`} key={item.id} onDragOver={event => { if (dragged && !priorityBusy) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragged && !priorityBusy) void reorder(dragged, item.id); setDragged(null); }}><div className="sf-project-card-top"><div className="sf-project-symbol"><Folder /></div><span className={item.role === "owner" ? "sf-role-badge sf-role-owner" : "sf-role-badge"}>{item.role === "owner" ? "我创建的" : "我加入的"}</span></div><h3><button className="sf-project-open" onClick={() => navigate(item.id)}>{item.name}<span aria-hidden="true"> ↗</span></button></h3><p>{item.researchPackages.length ? item.researchPackages[0].title : "准备好你的第一个研究目标，开始积累证据。"}</p><ProjectPriority name={item.name + "-" + item.id} value={item.stars ?? 3} busy={priorityBusy !== null} onChange={stars => void savePriority(item.id, stars)} /><div className="sf-project-card-bottom"><span><span aria-hidden="true">◇</span> {item.memberCount} 位成员 <i /> {item.researchPackages.length} 项任务</span><div className="sf-project-reorder"><button type="button" draggable={!priorityBusy} disabled={!!priorityBusy} aria-label={`拖动调整${item.name}的同星级顺序`} onDragStart={e => { setDragged(item.id); e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragged(null)}>⋮⋮</button>{([-1, 1] as const).map(direction => { const neighbor = sortedProjects[index + direction]; return <button key={direction} type="button" aria-label={`${direction === -1 ? "上移" : "下移"}${item.name}`} disabled={!!priorityBusy || !neighbor || (neighbor.stars ?? 3) !== (item.stars ?? 3)} onClick={() => void reorder(item.id, neighbor.id)}>{direction === -1 ? "↑" : "↓"}</button>; })}</div></div></article>)}</div> : <div className="sf-empty-projects"><div className="sf-empty-folder"><Folder large /></div><span className="sf-eyebrow">A NEW CHAPTER</span><h3>下一个好项目，从这里开始</h3><p>为一个想法创建空间，<br />也可以用邀请码加入已有项目。</p><span className="sf-empty-hint">创建或加入后，项目会出现在这里 →</span></div>}
        </section><aside className="sf-project-actions"><section className="sf-action-card sf-create-card"><span className="sf-action-number">01 / START SOMETHING</span><h2>创建新项目<span aria-hidden="true">＋</span></h2><p>为你的想法建立独立空间，<br />再邀请伙伴一起加入。</p><form onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); await mutateProject("create", { name: String(form.get("name") ?? "").trim() }); }}><label htmlFor="project-name">项目名称<input id="project-name" name="name" required maxLength={100} placeholder="例如：我的第一个研究项目" disabled={pending !== null} /></label><button className="primary" disabled={pending !== null}>{pending === "create" ? "正在创建…" : "创建项目"}<span aria-hidden="true">→</span></button></form></section><section className="sf-action-card sf-join-card"><span className="sf-action-number">02 / BETTER TOGETHER</span><h2>加入已有项目<span aria-hidden="true">↗</span></h2><p>已经收到伙伴的邀请？输入六位邀请码，接着一起前进。</p><form onSubmit={async event => { event.preventDefault(); await mutateProject("join", { inviteCode }); }}><label htmlFor="project-invite">项目邀请码<input id="project-invite" name="inviteCode" className="sf-code-input" value={inviteCode} onChange={event => setInviteCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} required minLength={6} maxLength={6} pattern="[A-Z0-9]{6}" placeholder="A7K2M9" autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={pending !== null} /></label><button className="secondary" disabled={pending !== null || inviteCode.length !== 6}>{pending === "join" ? "正在加入…" : "加入项目"}<span aria-hidden="true">→</span></button></form></section></aside></div>
      </>}
      <footer className="sf-app-footer"><span>ScenarioForge</span><p>事实有来源 · 推断有标记 · 决策由你确认</p><small>BUILD ON EVIDENCE.</small></footer>
    </div>
  </main>;
}
