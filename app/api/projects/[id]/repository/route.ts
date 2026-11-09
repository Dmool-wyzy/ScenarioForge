import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { checkRepositoryRemote, connectEmptyGitHubRepository, createRepositoryDeployKey, importGitHubRepository, initializeDemoRepository, mergeTaskDelivery, prepareRepositoryImport, pullRepositoryMain, pushRepositoryMain, repositoryOperation, repositoryRemoteStatus, repositorySummary, reviewTaskDelivery, storeTaskDelivery } from "@/lib/repository";
import { commitRepositoryFiles, compareRepositoryBranch, createRepositoryBranch, deleteRepositoryBranch, mergeRepositoryBranch, repositoryCommitDetail, repositoryFile, repositoryHistory, repositoryWorkspace } from "@/lib/repository-workspace";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { z } from "zod";
import { forwardRepositoryRequest } from "@/lib/repository-backend";
import { readActionRepository } from "@/lib/next-steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branchName = z.string().min(1).max(200);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("initialize") }), z.object({ action: z.literal("store"), taskId }),
  z.object({ action: z.literal("connect"), url: z.string().trim().max(200) }),
  z.object({ action: z.literal("prepare"), url: z.string().trim().max(200), branch: z.string().trim().max(200).default("") }),
  z.object({ action: z.literal("import") }),
  z.object({ action: z.literal("merge"), taskId, head: sha, commit: sha }),
  z.object({ action: z.literal("key") }), z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("push"), head: sha, remoteHead: sha.nullable() }),
  z.object({ action: z.literal("pull"), head: sha, remoteHead: sha }),
  z.object({ action: z.literal("branch-create"), name: branchName, from: branchName, head: sha }),
  z.object({ action: z.literal("branch-delete"), branch: branchName, head: sha }),
  z.object({ action: z.literal("branch-merge"), branch: branchName, head: sha, commit: sha }),
  z.object({ action: z.literal("files-commit"), branch: branchName, head: sha, message: z.string().trim().min(1).max(200), changes: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(2 * 1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional(), delete: z.boolean().optional() })).min(1).max(50) }),
]);

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    const deliveryId = new URL(request.url).searchParams.get("delivery");
    if (deliveryId) {
      const delivery = await db.agentSubtask.findFirst({ where: { id: taskId.parse(deliveryId), package: { projectId: id }, status: "submitted" }, select: { id: true, objective: true, assigneeName: true, assigneeId: true } });
      if (!delivery) throw new ApiError(404, "这份交付已不可查看，请刷新待办。");
      const state = await readActionRepository(request, id, [delivery.id]);
      return Response.json({ ...delivery, mine: delivery.assigneeId === user.id, git: state.tasks.find(t => t.id === delivery.id)?.git ?? null }, { headers: { "Cache-Control": "no-store" } });
    }
    const forwarded = await forwardRepositoryRequest(request, id);
    if (forwarded) return forwarded;
    const project = await db.project.findUniqueOrThrow({ where: { id }, select: { repositoryEnabled: true } });
    const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } }, select: { role: true } });
    const remote = await repositoryRemoteStatus(id, member.role === "owner");
    if (!project.repositoryEnabled) return Response.json({ enabled: false, remote, capabilities: { import: true, workspace: true } }, { headers: { "Cache-Control": "no-store" } });
    const query = new URL(request.url).searchParams;
    const view = query.get("view"), branch = branchName.parse(query.get("branch") ?? "main");
    if (view) {
      const actor = { id: user.id, username: user.username, owner: member.role === "owner" };
      const result = await repositoryOperation(id, async () => {
        if (view === "workspace") return repositoryWorkspace(id, branch, actor);
        if (view === "file") return repositoryFile(id, branch, z.string().min(1).max(500).parse(query.get("path")));
        if (view === "compare") return compareRepositoryBranch(id, branch);
        if (view === "history") return repositoryHistory(id, branch, z.coerce.number().int().min(0).max(10000).parse(query.get("skip") ?? 0));
        if (view === "commit") return repositoryCommitDetail(id, branch, sha.parse(query.get("commit")));
        throw new ApiError(400, "未知的仓库视图。");
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const selected = query.get("task");
    if (selected) return Response.json(await repositoryOperation(id, () => reviewTaskDelivery(id, taskId.parse(selected))), { headers: { "Cache-Control": "no-store" } });
    const summary = await repositoryOperation(id, () => repositorySummary(id));
    const tasks = await db.agentSubtask.findMany({ where: { package: { projectId: id }, status: "submitted" }, orderBy: { finishedAt: "desc" }, take: 50, select: { id: true, objective: true, assigneeName: true, assigneeId: true } });
    return Response.json({ enabled: true, capabilities: { import: true, workspace: true }, head: summary.head, remoteUrl: summary.remoteUrl, remoteBranch: summary.remoteBranch, remote, files: summary.files, tasks: tasks.map(task => ({ ...task, mine: task.assigneeId === user.id, git: summary.branches.find(branch => branch.taskId === task.id) ?? null })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`repository:${user.id}`, 100, 15 * 60000);
    const action = actionSchema.parse(await readJson(request, 6 * 1024 * 1024));
    const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } }, include: { project: { select: { repositoryEnabled: true } } } });
    if (!["store", "branch-create", "branch-delete", "files-commit"].includes(action.action) && member.role !== "owner") throw new ApiError(403, "只有项目创建者可以管理仓库、配置认证、合并或推送。");
    const forwarded = await forwardRepositoryRequest(request, id, action);
    if (forwarded) return forwarded;
    const actor = { id: user.id, username: user.username, owner: member.role === "owner" };
    const result = await repositoryOperation(id, async () => {
      if (action.action === "prepare") { await prepareRepositoryImport(id, action.url, action.branch); return; }
      if (action.action === "import") {
        await importGitHubRepository(id);
        await db.project.update({ where: { id }, data: { repositoryEnabled: true } });
        return;
      }
      if (action.action === "connect") {
        await connectEmptyGitHubRepository(id, action.url);
        await db.project.update({ where: { id }, data: { repositoryEnabled: true } });
        return;
      }
      if (action.action === "initialize") {
        await initializeDemoRepository(id);
        await db.project.update({ where: { id }, data: { repositoryEnabled: true } });
        return;
      }
      if (!member.project.repositoryEnabled) throw new ApiError(409, "请先由组长创建演示仓库。");
      if (action.action === "key") { await createRepositoryDeployKey(id); return; }
      if (action.action === "check") { await checkRepositoryRemote(id); return; }
      if (action.action === "push") { await pushRepositoryMain(id, action.head, action.remoteHead); return; }
      if (action.action === "pull") return pullRepositoryMain(id, action.head, action.remoteHead);
      if (action.action === "branch-create") return createRepositoryBranch(id, actor, action.name, action.from, action.head);
      if (action.action === "branch-delete") return deleteRepositoryBranch(id, action.branch, action.head, actor);
      if (action.action === "branch-merge") return mergeRepositoryBranch(id, action.branch, action.head, action.commit);
      if (action.action === "files-commit") return commitRepositoryFiles(id, actor, action.branch, action.head, action.message, action.changes);
      const task = await db.agentSubtask.findFirst({ where: { id: action.taskId, package: { projectId: id }, status: "submitted", ...(action.action === "store" ? { assigneeId: user.id } : {}) } });
      if (!task) throw new ApiError(404, "未找到已确认提交且有权操作的任务。");
      if (action.action === "store") await storeTaskDelivery(id, task);
      else await mergeTaskDelivery(id, action.taskId, action.head, action.commit);
    });
    return Response.json({ ok: true, ...result });
  } catch (error) { return errorResponse(error); }
}
