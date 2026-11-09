import "server-only";
import { db } from "./db";
import { forwardRepositoryRequest } from "./repository-backend";
import { repositoryOperation, repositorySummary } from "./repository";
import type { NextAction, NextStepsSnapshot } from "./next-step-ranking";
import { taskDeadline, type KnownDeadline } from "./task-deadline";

type GitState = { enabled: boolean; tasks: { id: string; git: { merged: boolean; commit?: string; branch?: string } | null }[] };
export async function readActionRepository(request: Request, projectId: string, taskIds: string[] = []): Promise<GitState> {
  const cleanRequest = new Request(new URL("/", request.url), { headers: request.headers, signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
  const remote = await forwardRepositoryRequest(cleanRequest, projectId);
  if (remote) {
    if (!remote.ok) throw new Error("Repository unavailable");
    const value = await remote.json();
    const tasks: GitState["tasks"] = value.tasks ?? [];
    // The existing repository list is paginated at 50. Verify older deliveries
    // individually instead of treating an absent list row as an absent branch.
    if (value.enabled) for (const id of taskIds.filter(id => !tasks.some(t => t.id === id))) {
      const target = new URL(cleanRequest.url); target.searchParams.set("task", id);
      const result = await forwardRepositoryRequest(new Request(target, { headers: request.headers, signal: cleanRequest.signal }), projectId);
      if (result?.status === 404) tasks.push({ id, git: null });
      else if (result?.ok) { const review = await result.json(); tasks.push({ id, git: { merged: review.merged, commit: review.commit, branch: `task/${id}` } }); }
      else throw new Error("Repository unavailable");
    }
    return { enabled: value.enabled, tasks };
  }
  const summary = await repositoryOperation(projectId, () => repositorySummary(projectId));
  return { enabled: true, tasks: summary.branches.map(b => ({ id: b.taskId, git: { merged: b.merged, commit: b.commit, branch: b.branch } })) };
}

export async function listNextSteps(userId: string, request: Request,
  readRepository = readActionRepository): Promise<NextStepsSnapshot> {
  const memberships = await db.projectMember.findMany({ where: { userId }, select: {
    projectId: true, role: true, personalPriority: { select: { stars: true } },
    project: { select: { name: true, repositoryEnabled: true } },
  } });
  const projectIds = memberships.map(m => m.projectId);
  const ownerIds = memberships.filter(m => m.role === "owner").map(m => m.projectId);
  // Never read another member's draft, conversation or model configuration.
  const [tasks, packages, settings] = await Promise.all([
    db.agentSubtask.findMany({ where: { package: { projectId: { in: projectIds } }, OR: [
      { assigneeId: userId, status: { in: ["running", "chatting", "review", "failed", "submitted"] } },
      { status: "submitted", package: { projectId: { in: ownerIds } } },
    ] }, select: { id: true, objective: true, status: true, assigneeId: true, createdAt: true, finishedAt: true, chatLeaseUntil: true, package: { select: { id: true, projectId: true } } } }),
    db.researchPackage.findMany({ where: { projectId: { in: ownerIds } }, select: {
      id: true, projectId: true, title: true, status: true, taskState: true, createdAt: true,
      clarifications: { where: { status: { in: ["waiting", "blocked"] } }, select: { id: true, question: true, priority: true, createdAt: true } },
      events: { where: { type: "research_failed" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    } }),
    db.personalActionSetting.findMany({ where: { userId, projectId: { in: projectIds } } }),
  ]);
  const actions: NextAction[] = [], warnings: string[] = [];
  const now = Date.now();
  const deadline = new Map(settings.map(s => [`${s.projectId}:${s.actionKey}`, s.dueAt?.toISOString() ?? null]));
  const link = (projectId: string, packageId: string | null, target: string) => {
    const query = new URLSearchParams({ project: projectId });
    if (packageId) query.set("package", packageId);
    return `/?${query}#${target}`;
  };
  const add = (projectId: string, item: Omit<NextAction, "projectId" | "projectName" | "stars" | "dueAt">, known: KnownDeadline | null = null) => {
    const m = memberships.find(m => m.projectId === projectId)!;
    const personal = deadline.get(`${projectId}:${item.id}`) ?? null;
    actions.push({ ...item, projectId, projectName: m.project.name, stars: m.personalPriority?.stars ?? 3,
      dueAt: known?.dueAt ?? personal, deadlineSource: known?.source ?? (personal ? "personal" : null),
      deadlinePrecision: known?.precision ?? null, deadlineRelative: known?.relative ?? false });
  };
  for (const task of tasks.filter(t => t.status !== "submitted")) {
    const projectId = task.package.projectId!;
    const recover = task.status === "chatting" && !!task.chatLeaseUntil && task.chatLeaseUntil.getTime() < now;
    const waiting = task.status === "running" || (task.status === "chatting" && !recover);
    add(projectId, { id: `task:${task.id}`, kind: "task", title: task.objective,
      detail: waiting ? "个人 Agent 正在处理，完成后会进入待办。" : recover ? "本轮对话已超时，可恢复并检查原有内容。" : task.status === "failed" ? "执行中断，可检查原因、手动整理并提交。" : "初稿已就绪，检查或修改后确认提交给团队。",
      label: waiting ? "查看进度" : "打开我的任务", state: waiting ? "waiting" : "ready", blocksOthers: false, inProgress: true,
      waitingSince: (task.finishedAt ?? task.createdAt).toISOString(), href: link(projectId, null, `personal-task-${task.id}`) }, taskDeadline(task));
  }
  const gitStates = new Map<string, GitState | null>();
  await Promise.all(memberships.filter(m => m.project.repositoryEnabled).map(async m => {
    const deliveries = tasks.filter(t => t.status === "submitted" && t.package.projectId === m.projectId);
    if (!deliveries.length) return;
    try { gitStates.set(m.projectId, await readRepository(request, m.projectId, deliveries.map(t => t.id))); }
    catch { gitStates.set(m.projectId, null); }
  }));
  // Git state comes from the actual repository. Do not infer a pending review from a submitted DB row.
  for (const m of memberships) {
    const deliveries = tasks.filter(t => t.status === "submitted" && t.package.projectId === m.projectId);
    if (!deliveries.length) continue;
    let repo: GitState = { enabled: false, tasks: [] };
    if (m.project.repositoryEnabled) {
      const checked = gitStates.get(m.projectId);
      if (!checked) { warnings.push(`${m.project.name}：暂时无法核对 Git 交付状态，相关事项未参与推荐。`); continue; }
      repo = checked;
    }
    if (!repo.enabled && m.role === "owner") {
      add(m.projectId, { id: "repository:setup", kind: "repository", title: "为已提交的交付准备 Git 工作区", detail: "成员交付已提交，连接或创建工作区后可继续保存与审查。", label: "打开 Git 工作区", state: "ready", blocksOthers: true, inProgress: false, waitingSince: deliveries.map(t => (t.finishedAt ?? t.createdAt).toISOString()).sort()[0], href: link(m.projectId, null, "project-repository") });
    }
    for (const task of deliveries) {
      const git = repo.tasks.find(t => t.id === task.id)?.git;
      if (git?.merged) continue;
      const mine = task.assigneeId === userId;
      const review = repo.enabled && !!git && m.role === "owner";
      const store = repo.enabled && !git && mine;
      if (!mine && !review) continue;
      add(m.projectId, { id: `delivery:${task.id}`, kind: "delivery", title: task.objective,
        detail: review ? "交付已保存到任务分支，请查看差异并决定是否合并。" : store ? "已确认提交给团队，下一步保存到 Git 任务分支。" : repo.enabled ? "交付已进入任务分支，等待项目创建者审查。" : "交付已提交，等待项目创建者准备 Git 工作区。",
        label: review ? "审查交付差异" : store ? "保存交付到 Git" : "查看交付", state: review || store ? "ready" : "waiting", blocksOthers: review, inProgress: true,
        waitingSince: (task.finishedAt ?? task.createdAt).toISOString(), href: link(m.projectId, null, repo.enabled ? `delivery-${task.id}` : "project-repository") }, taskDeadline(task));
    }
  }
  for (const pkg of packages) {
    for (const q of pkg.clarifications) {
      add(pkg.projectId!, { id: `clarification:${q.id}`, kind: "clarification", title: q.question,
      detail: q.priority === "blocking" ? "研究正在等待团队确认，回答后可继续。" : "补充这项信息可以完善当前研究。", label: "回答澄清问题", state: "ready", blocksOthers: q.priority === "blocking", inProgress: false,
      waitingSince: q.createdAt.toISOString(), href: link(pkg.projectId!, pkg.id, `clarification-${q.id}`) });
    }
    if (["queued", "running"].includes(pkg.taskState)) {
      add(pkg.projectId!, { id: `research:${pkg.id}`, kind: "research", title: pkg.title, detail: "研究正在排队或执行，等待本轮结果。", label: "查看研究进度", state: "waiting", blocksOthers: false, inProgress: true, waitingSince: pkg.createdAt.toISOString(), href: link(pkg.projectId!, pkg.id, "research-progress") });
    } else if (pkg.status === "failed") {
      add(pkg.projectId!, { id: `research:${pkg.id}`, kind: "research", title: "检查中断的研究并继续", detail: pkg.title, label: "查看失败原因", state: "ready", blocksOthers: false, inProgress: true, waitingSince: (pkg.events[0]?.createdAt ?? pkg.createdAt).toISOString(), href: link(pkg.projectId!, pkg.id, "research-progress") });
    }
  }
  return { actions, warnings, generatedAt: new Date().toISOString() };
}
