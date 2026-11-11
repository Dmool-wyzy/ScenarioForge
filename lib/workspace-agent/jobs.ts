import "server-only";
import { randomUUID } from "node:crypto";
import { Runner, type Model, type ModelSettings } from "@openai/agents";
import type { WorkspaceExecution } from "@prisma/client";
import { db } from "../db";
import { ApiError, logError, publicError } from "../errors";
import { emitEvent } from "../events";
import { executionResearchConfig, modelProviderData } from "../model-settings";
import { createModelProvider } from "../openai";
import { AgentWorkspace, prepareAgentWorkspace } from "./workspace";
import { runWorkspaceAgent } from "./agent";
import { checksAtHead, recordCheck } from "./checks";
import { LocalRunnerWorkspace } from "./local-runner";
import type { WorkspacePort } from "./port";
import type { SkillFile, Verification } from "./types";
import { createProgressReporter, type ReportExecutionProgress } from "./progress";
import { modelPolicyFromConfig, type ModelPolicySettings } from "../model-policy";
import type { ModelDiagnosticOptions } from "../model-diagnostics";
import { modelDiagnosticProgress } from "./model-progress";
import { workspaceFailureDiagnostic } from "./failure-diagnostic";

const LEASE_MS = 120000;
const state = globalThis as unknown as { workspaceExecutionTick?: boolean };
export type ExecutionRuntime = { model: string | Model; settings?: ModelSettings; policy?: ModelPolicySettings; modelDiagnostics?: boolean; runner?: Runner; close?: () => Promise<void> };
export type ResolveExecutionModel = (run: WorkspaceExecution, onProgress?: ReportExecutionProgress) => Promise<ExecutionRuntime>;
const resolveExecutionModel: ResolveExecutionModel = async (run, onProgress) => {
  const projectId = (await db.researchPackage.findUniqueOrThrow({ where: { id: run.packageId }, select: { projectId: true } })).projectId;
  if (!projectId) throw new ApiError(409, "任务项目不存在。");
  const env = await executionResearchConfig(projectId, run.modelConfigEncrypted);
  const policy = modelPolicyFromConfig(env), scope = randomUUID();
  const onDiagnostic: ModelDiagnosticOptions["onDiagnostic"] = onProgress ? async diagnostic => {
    const { message, progress } = modelDiagnosticProgress(diagnostic, scope, env.MODEL_TIMEOUT_SECONDS, policy.maxOutputTokens != null);
    await onProgress(message, progress);
  } : undefined;
  const provider = createModelProvider(env, { onDiagnostic });
  return { model: env.SCENARIOFORGE_MODEL, policy, modelDiagnostics: Boolean(onDiagnostic), settings: { providerData: modelProviderData(policy) },
    runner: new Runner({ modelProvider: provider, tracingDisabled: true, traceIncludeSensitiveData: false }), close: () => provider.close() };
};
// Internal entry point also lets isolated database acceptance use a deterministic model.
export async function executeWorkspaceExecution(id: string, resolveModel: ResolveExecutionModel = resolveExecutionModel) {
  const owner = randomUUID(), now = new Date();
  const claimed = await db.workspaceExecution.updateMany({ where: { id, attempts: { lt: 3 }, OR: [{ status: "queued" }, { status: "running", leaseUntil: { lt: now } }] },
    data: { status: "running", leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 }, error: null } });
  if (!claimed.count) return;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10 * 60000);
  const assertActive = async () => {
    abort.signal.throwIfAborted();
    const current = await db.workspaceExecution.findUniqueOrThrow({ where: { id }, include: { package: { select: { projectId: true } } } });
    if (current.status !== "running" || current.leaseOwner !== owner || !current.leaseUntil || current.leaseUntil <= new Date()) { abort.abort(); throw new ApiError(409, "执行已停止或租约失效，文件保留在任务分支。"); }
    const member = current.package.projectId && await db.projectMember.findUnique({ where: { projectId_userId: { projectId: current.package.projectId, userId: current.createdBy } } });
    if (!member) { abort.abort(); throw new ApiError(403, "执行成员已失去项目权限。"); }
  };
  const heartbeat = setInterval(() => {
    void assertActive().then(() => db.workspaceExecution.updateMany({ where: { id, status: "running", leaseOwner: owner }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }))
      .then(result => { if (!result.count) abort.abort(); }).catch(() => abort.abort());
  }, 2000);
  let close: (() => Promise<void>) | undefined;
  let packageId: string | undefined;
  try {
    const run = await db.workspaceExecution.findUniqueOrThrow({ where: { id }, include: { package: { select: { projectId: true } } } });
    packageId = run.packageId;
    const projectId = run.package.projectId;
    if (!projectId || (run.target !== "local" && !run.baseCommit)) throw new ApiError(409, "任务项目或起始版本不存在。");
    const user = await db.user.findUniqueOrThrow({ where: { id: run.createdBy }, select: { id: true, username: true } });
    await assertActive();
    const actor = { ...user, owner: false }, skills = JSON.parse(run.skills) as SkillFile[];
    const onProgress: ReportExecutionProgress = async (message, progress) => {
      await assertActive(); await emitEvent(run.packageId, "execution_progress", message, { executionId: id, ...(progress ? { progress } : {}) });
    };
    const recordPreparation = createProgressReporter(onProgress);
    const { workspace, prepared } = await recordPreparation({ action: "setup", message: run.target === "local" ? "正在连接本地 Runner 并读取工作区快照" : "正在准备任务分支和技能快照", run: async () => {
      if (run.target === "local") {
        if (!run.runnerId) throw new ApiError(409, "本地 Runner 已移除。");
        const runner = await db.localRunner.findFirst({ where: { id: run.runnerId, userId: run.createdBy, projectId, revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 30_000) } } });
        if (!runner) throw new ApiError(409, "本地 Runner 离线，请保持连接后恢复任务。");
        const workspace: WorkspacePort = new LocalRunnerWorkspace(id, run.runnerId, run.localReview, abort.signal, owner);
        const view = await workspace.list(), head = view.head;
        return { workspace, prepared: { branch: workspace.branch, baseCommit: run.baseCommit ?? head, head }, fileCount: view.total };
      }
      const prepared = await prepareAgentWorkspace(projectId, id, actor, skills, run.baseCommit!);
      return { workspace: new AgentWorkspace(projectId, prepared.branch, actor, assertActive) as WorkspacePort, prepared };
    }, completed: result => ({ message: run.target === "local" ? `本地 Runner 已连接：工作区包含 ${result.fileCount} 个可操作文件` : "任务分支与技能快照已就绪",
      detail: result.fileCount === undefined ? undefined : { fileCount: result.fileCount } }) });
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM WorkspaceExecution WHERE id = ${id} FOR UPDATE`;
      const latest = await tx.workspaceExecution.findUniqueOrThrow({ where: { id } });
      if (latest.status !== "running" || latest.leaseOwner !== owner || !latest.leaseUntil || latest.leaseUntil <= new Date()) throw new ApiError(409, "执行租约已变化。");
      // A crash between a Git commit and checkpoint, or a manual edit while stopped,
      // can leave the saved head behind the branch. Never carry checks across commits.
      await tx.workspaceExecution.update({ where: { id }, data: { ...prepared, verification: JSON.stringify(checksAtHead(latest.verification, prepared.head)) } });
    });
    await assertActive();
    const runtime = await resolveModel(run, onProgress); close = runtime.close;
    const onCheckpoint = async (head: string, verification?: Verification) => {
      await assertActive();
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM WorkspaceExecution WHERE id = ${id} FOR UPDATE`;
        const latest = await tx.workspaceExecution.findUniqueOrThrow({ where: { id } });
        if (latest.status !== "running" || latest.leaseOwner !== owner || !latest.leaseUntil || latest.leaseUntil <= new Date()) throw new ApiError(409, "执行租约已变化。");
        const merged = recordCheck(latest.verification, head, verification);
        await tx.workspaceExecution.update({ where: { id }, data: { head, verification: JSON.stringify(merged) } });
      });
      const message = verification
        ? run.target === "local" ? verification.kind === "command" ? "本机命令验证结果已保存" : "本地文件检查结果已保存" : verification.output.slice(0, 1500)
        : run.target === "local" ? "文件变更已保存到本地工作区" : "文件变更已保存到任务分支";
      await emitEvent(run.packageId, "execution_checkpoint", message, { executionId: id, head, ...(verification ? { status: verification.status, kind: verification.kind } : {}) });
    };
    await emitEvent(run.packageId, "execution_started", "Agent 开始读取技能与工作区", { executionId: id, branch: prepared.branch });
    const result = await runWorkspaceAgent({ model: runtime.model, settings: runtime.settings,
      runner: runtime.runner, workspace, policy: runtime.policy, modelDiagnostics: runtime.modelDiagnostics,
      skills, request: run.request, baseCommit: prepared.baseCommit, signal: abort.signal, onCheckpoint,
      onProgress });
    await assertActive();
    const latest = await db.workspaceExecution.findUniqueOrThrow({ where: { id } });
    const checks = checksAtHead(latest.verification, result.verification.head);
    const changed = result.review.changedPaths.some(filename => !filename.startsWith(".scenarioforge/"));
    const status = changed && result.verification.status === "passed" && !checks.some(check => check.status !== "passed") ? "completed" : "review";
    const updated = await db.workspaceExecution.updateMany({ where: { id, status: "running", leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status, summary: result.summary.slice(0, 12000), leaseOwner: null, leaseUntil: null } });
    if (updated.count) await emitEvent(run.packageId, "execution_completed", "本轮文件已保存，请审查差异和验证结果", { executionId: id, status });
  } catch (error) {
    const latest = await db.workspaceExecution.findUnique({ where: { id } });
    const stopped = latest?.status === "stopping";
    const message = stopped ? "任务已停止，已保存文件和技能快照保留，可从原分支继续。" : abort.signal.aborted ? "执行超时或中断，文件保留，可从原分支继续。" : publicError(error);
    if (!stopped && !abort.signal.aborted && message === "服务暂时无法完成请求，请检查服务端配置或稍后重试。") {
      console.error("[ScenarioForge] Workspace execution diagnostic", JSON.stringify({ executionId: id, ...workspaceFailureDiagnostic(error) }));
    }
    const updated = await db.workspaceExecution.updateMany({ where: { id, leaseOwner: owner }, data: { status: stopped ? "stopped" : "failed", error: message, leaseOwner: null, leaseUntil: null } });
    if (updated.count && packageId) await emitEvent(packageId, "execution_failed", message, { executionId: id });
  } finally {
    clearTimeout(timeout); clearInterval(heartbeat); await close?.().catch(() => {});
    await db.localRunnerCommand.updateMany({ where: { executionId: id, executionLease: owner }, data: { input: "{}", result: null } }).catch(() => {});
    await db.localRunnerCommand.updateMany({ where: { executionId: id, executionLease: owner, status: { in: ["approval", "pending", "claimed", "executing"] } }, data: { status: "expired" } }).catch(() => {});
  }
}
export async function tickWorkspaceExecutions() {
  if (state.workspaceExecutionTick) return;
  state.workspaceExecutionTick = true;
  try {
    await db.workspaceExecution.updateMany({ where: { status: "stopping", leaseUntil: { lt: new Date() } }, data: { status: "stopped", leaseOwner: null, leaseUntil: null } });
    await db.workspaceExecution.updateMany({ where: { status: "running", leaseUntil: { lt: new Date() }, attempts: { gte: 3 } }, data: { status: "failed", error: "已达到执行恢复上限，已有文件保留。", leaseOwner: null, leaseUntil: null } });
    const active = await db.workspaceExecution.count({ where: { status: "running", leaseUntil: { gt: new Date() } } });
    if (active >= 2) return;
    const pending = await db.workspaceExecution.findMany({ where: { attempts: { lt: 3 }, OR: [{ status: "queued" }, { status: "running", leaseUntil: { lt: new Date() } }] }, take: 2 - active, orderBy: { createdAt: "asc" }, select: { id: true } });
    for (const run of pending) void executeWorkspaceExecution(run.id).catch(logError);
  } catch (error) {
    // Existing installations can keep research running before the additive migration is applied.
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2021")) logError(error);
  } finally { state.workspaceExecutionTick = false; }
}
