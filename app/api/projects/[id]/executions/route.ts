import { z } from "zod";
import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { startTaskScheduler } from "@/lib/tasks";
import { AgentWorkspace } from "@/lib/workspace-agent/workspace";
import { decideLocalCommand, listProjectRunners, LocalRunnerWorkspace, pendingLocalCommands } from "@/lib/workspace-agent/local-runner";
import { controlExecution, createExecution, executionView, skillCatalog } from "@/lib/workspace-agent/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const identifier = z.string().min(1).max(100);
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), request: z.string().trim().min(1).max(5000), packageId: identifier.optional(), skillIds: z.array(identifier).max(20), target: z.enum(["github", "local"]).default("github"), runnerId: identifier.optional() }),
  z.object({ action: z.enum(["stop", "resume"]), executionId: identifier }),
  z.object({ action: z.enum(["approve_command", "reject_command"]), executionId: identifier, commandId: identifier }).strict(),
]);
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params, user = await requireProjectAccess(request, id);
    const params = new URL(request.url).searchParams, runId = params.get("run");
    if (runId) {
      const run = await db.workspaceExecution.findFirst({ where: { id: identifier.parse(runId), package: { projectId: id } } });
      if (run?.target === "local") {
        if (run.createdBy !== user.id) throw new ApiError(404, "执行任务不存在。");
        const workspace = new LocalRunnerWorkspace(run.id, run.runnerId ?? "", run.localReview);
        const review = workspace.savedReview(), file = params.get("file");
        const head = review.head ?? run.head ?? "local";
        return Response.json(file ? { ...await workspace.preview(file), head } : { ...review, head }, { headers: { "Cache-Control": "no-store" } });
      }
      if (!run || !run.branch || !run.baseCommit) throw new ApiError(404, "执行任务不存在。");
      const workspace = new AgentWorkspace(id, run.branch, { ...user, owner: false }), file = params.get("file");
      return Response.json(file ? await workspace.read(file) : { ...await workspace.list(), ...await workspace.diff(run.baseCommit) }, { headers: { "Cache-Control": "no-store" } });
    }
    const pkg = params.get("package");
    const runs = await db.workspaceExecution.findMany({ where: { package: { projectId: id }, OR: [{ target: "github" }, { target: "local", createdBy: user.id }], ...(pkg ? { packageId: identifier.parse(pkg) } : {}) }, orderBy: { createdAt: "desc" }, take: 10 });
    const project = await db.project.findUniqueOrThrow({ where: { id }, select: { repositoryEnabled: true } });
    const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } } });
    const approvals = await pendingLocalCommands(id, user.id, runs.filter(run => run.target === "local" && run.createdBy === user.id).map(run => run.id));
    return Response.json({ executions: runs.map(run => ({ ...executionView(run), commandApprovals: approvals.get(run.id) ?? [] })), skills: await skillCatalog(id, pkg ?? undefined), runners: await listProjectRunners(id, user.id), repositoryEnabled: project.repositoryEnabled, userId: user.id, owner: member.role === "owner" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2021") return Response.json({ error: "工作区执行功能需要先应用新增数据库迁移。原有研究和文档仍可使用。" }, { status: 503 });
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params, user = await requireProjectAccess(request, id);
    rateLimit(`execution:${user.id}`, 30, 15 * 60000);
    const action = input.parse(await readJson(request));
    if (action.action === "start") {
      const result = await createExecution(id, user.id, action);
      startTaskScheduler(); return Response.json(result, { status: 202 });
    }
    if (action.action === "approve_command" || action.action === "reject_command") {
      await decideLocalCommand(id, user.id, action.executionId, action.commandId, action.action === "approve_command");
      return Response.json({ ok: true });
    }
    await controlExecution(id, user.id, action.executionId, action.action);
    startTaskScheduler(); return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
