import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "@prisma/client";
import { appendEvent } from "../events";
import { ApiError } from "../errors";
import type { WorkspacePort } from "./port";
import type { ExecutionProgress, LocalCommandApproval, Verification } from "./types";
import { agentFilePath } from "./workspace";
import { progressCommand } from "./progress";
import { runnerDirectory } from "../local-runner/directory";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type DiffEntry = { path: string; before: string | null; after: string | null };
const commandInput = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), command: z.array(z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value))).min(1).max(20), receiptBudget: z.number().nonnegative() });
const commandPath = z.string().max(500).refine(value => {
  try { return agentFilePath(value) === value && !value.split("/").some(part => [".next", ".tmp", ".cache", ".turbo", "dist", "build", "coverage"].includes(part.toLowerCase())); }
  catch { return false; }
});
const commandResult = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/), beforeHead: z.string().regex(/^[a-f0-9]{40}$/), kind: z.literal("command"),
  command: commandInput.shape.command, status: z.enum(["passed", "failed", "unavailable"]), output: z.string().max(12000),
  entries: z.array(z.object({ path: commandPath, before: z.string().max(40000).nullable(), after: z.string().max(40000).nullable() })).max(300),
});
function unexecuted(input: z.infer<typeof commandInput>, output: string) {
  return { head: input.head, beforeHead: input.head, command: input.command, kind: "command" as const, status: "unavailable" as const, output, entries: [] };
}
function localDiff(entries: DiffEntry[]) {
  return entries.map(entry => {
    const before = entry.before?.split("\n") ?? [], after = entry.after?.split("\n") ?? [];
    return ["--- " + (entry.before === null ? "/dev/null" : "a/" + entry.path), "+++ " + (entry.after === null ? "/dev/null" : "b/" + entry.path),
      ...before.map(line => "-" + line), ...after.map(line => "+" + line)].join("\n");
  }).join("\n").slice(0, 60000);
}

export async function createRunnerPairing(projectId: string, userId: string, label: string) {
  const code = randomUUID() + randomUUID(), id = randomUUID();
  await db.localRunner.create({ data: { id, projectId, userId, label, pairingHash: hash(code), pairingExpires: new Date(Date.now() + 10 * 60_000), expiresAt: new Date(Date.now() + 30 * 86400_000) } });
  return { id, code, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
}

export async function listProjectRunners(projectId: string, userId: string) {
  const runners = await db.localRunner.findMany({ where: { projectId, userId, revokedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, label: true, workspaceDirectory: true, lastSeenAt: true, expiresAt: true, createdAt: true } });
  return runners.map(runner => ({ ...runner, online: Boolean(runner.lastSeenAt && runner.lastSeenAt.getTime() > Date.now() - 30_000) }));
}

export async function revokeProjectRunner(projectId: string, userId: string, id: string) {
  const result = await db.localRunner.updateMany({ where: { id, projectId, userId, revokedAt: null }, data: { revokedAt: new Date(), tokenHash: null, pairingHash: null } });
  if (!result.count) throw new ApiError(404, "本地 Runner 不存在。");
}

export async function exchangeRunnerPairing(code: string, directory?: string) {
  const workspaceDirectory = directory === undefined ? null : runnerDirectory.parse(directory);
  const codeHash = hash(code);
  const runner = await db.localRunner.findFirst({ where: { pairingHash: codeHash, pairingExpires: { gt: new Date() }, revokedAt: null, tokenHash: null } });
  if (!runner) throw new ApiError(401, "配对码无效或已过期。");
  const token = randomUUID() + randomUUID();
  const changed = await db.localRunner.updateMany({ where: { id: runner.id, pairingHash: codeHash, tokenHash: null, revokedAt: null, pairingExpires: { gt: new Date() } }, data: { tokenHash: hash(token), pairingHash: null, workspaceDirectory } });
  if (!changed.count) throw new ApiError(409, "配对码已使用，请重新生成。");
  return { runnerId: runner.id, projectId: runner.projectId, label: runner.label, token, expiresAt: runner.expiresAt.toISOString() };
}

export async function authorizeRunner(id: string, token: string) {
  const runner = await db.localRunner.findFirst({ where: { id, tokenHash: hash(token), revokedAt: null, expiresAt: { gt: new Date() } } });
  if (!runner) throw new ApiError(401, "Runner 令牌无效、已过期或已撤销。");
  const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: runner.projectId, userId: runner.userId } }, select: { userId: true } });
  if (!member) throw new ApiError(403, "Runner 所属成员已失去项目权限。");
  await db.localRunner.update({ where: { id }, data: { lastSeenAt: new Date() } });
  return runner;
}

/** Legacy paired connections report their actual root once on CLI startup. */
export async function registerRunnerDirectory(id: string, token: string, directory: string) {
  const workspaceDirectory = runnerDirectory.parse(directory);
  await db.$transaction(async tx => {
    // Serialize first reporting with task creation so execution snapshots are
    // either the known root or explicitly unknown, never an invented fallback.
    await tx.$queryRaw`SELECT id FROM LocalRunner WHERE id = ${id} FOR UPDATE`;
    const runner = await tx.localRunner.findFirst({ where: { id, tokenHash: hash(token), revokedAt: null, expiresAt: { gt: new Date() } } });
    if (!runner) throw new ApiError(401, "Runner 令牌无效、已过期或已撤销。");
    const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: runner.projectId, userId: runner.userId } }, select: { userId: true } });
    if (!member) throw new ApiError(403, "Runner 所属成员已失去项目权限。");
    // Compare in JS: a case-insensitive database collation must not allow a
    // different POSIX directory to replace the original binding.
    if (runner.workspaceDirectory !== null && runner.workspaceDirectory !== workspaceDirectory) throw new ApiError(409, "Runner 绑定目录已变化，请为新目录重新配对。");
    await tx.localRunner.update({ where: { id }, data: { workspaceDirectory, lastSeenAt: new Date() } });
  });
}

/** Only the local task creator can see or approve its immutable command payload. */
export async function pendingLocalCommands(projectId: string, userId: string, executionIds: string[]) {
  const now = new Date();
  const rows = await db.localRunnerCommand.findMany({ where: { executionId: { in: executionIds }, operation: "exec", status: "approval", expiresAt: { gt: now },
    execution: { createdBy: userId, target: "local", status: "running", leaseUntil: { gt: now }, package: { projectId } }, runner: { revokedAt: null, expiresAt: { gt: now } } },
    include: { execution: { select: { leaseOwner: true } } }, orderBy: { createdAt: "asc" } });
  const result = new Map<string, LocalCommandApproval[]>();
  for (const row of rows) {
    if (row.executionLease !== row.execution.leaseOwner) continue;
    const input = commandInput.parse(JSON.parse(row.input));
    const approvals = result.get(row.executionId) ?? [];
    approvals.push({ id: row.id, command: input.command, head: input.head, expiresAt: row.expiresAt.toISOString() });
    result.set(row.executionId, approvals);
  }
  return result;
}

async function commandProgress(tx: Prisma.TransactionClient, executionId: string, commandId: string, message: string, progress: Omit<ExecutionProgress, "operationId">) {
  const execution = await tx.workspaceExecution.findUniqueOrThrow({ where: { id: executionId }, select: { packageId: true } });
  await appendEvent(tx, execution.packageId, "execution_progress", message, { executionId, progress: { ...progress, operationId: "command:" + commandId } });
}

export async function decideLocalCommand(projectId: string, userId: string, executionId: string, commandId: string, approve: boolean) {
  const now = new Date();
  const command = await db.localRunnerCommand.findFirst({ where: { id: commandId, executionId, operation: "exec", status: "approval", expiresAt: { gt: now },
    execution: { createdBy: userId, target: "local", status: "running", leaseUntil: { gt: now }, package: { projectId } },
    runner: { userId, projectId, revokedAt: null, expiresAt: { gt: now } } } });
  if (!command) throw new ApiError(404, "待审批命令不存在或已失效。");
  const input = commandInput.parse(JSON.parse(command.input));
  await db.$transaction(async tx => {
  const updated = await tx.localRunnerCommand.updateMany({ where: { id: commandId, executionId, status: "approval", expiresAt: { gt: new Date() },
    execution: { createdBy: userId, status: "running", leaseOwner: command.executionLease, leaseUntil: { gt: new Date() }, package: { projectId } },
    runner: { userId, projectId, revokedAt: null, expiresAt: { gt: new Date() } } },
    data: approve ? { status: "pending", expiresAt: new Date(Date.now() + 60_000) } : { status: "completed", result: JSON.stringify(unexecuted(input, "命令未执行：用户拒绝了本次命令。")), expiresAt: new Date(Date.now() + 60_000) } });
  if (!updated.count) throw new ApiError(409, "命令已处理、过期或执行租约已变化。");
  await commandProgress(tx, executionId, commandId, approve ? "命令已批准，等待 Runner 领取" : "命令未执行：你已拒绝本次命令", {
    action: "command_approval", phase: "completed", command: progressCommand(input.command), ...(approve ? {} : { status: "unavailable" }),
  });
  });
}

/** A start permit is consumed once. Subsequent confirmations only keep the same process alive. */
export async function confirmRunnerCommand(runnerId: string, id: string, leaseOwner: string, start = false) {
  const now = new Date();
  const command = await db.localRunnerCommand.findFirst({ where: { id, runnerId, leaseOwner, operation: "exec", status: start ? "claimed" : "executing", expiresAt: { gt: now } }, select: { executionLease: true } });
  if (!command) throw new ApiError(409, "本机命令授权已结束。");
  const where = { id, runnerId, leaseOwner, operation: "exec", status: start ? "claimed" : "executing", expiresAt: { gt: now },
    execution: { runnerId, status: "running", leaseOwner: command.executionLease, leaseUntil: { gt: now } }, runner: { revokedAt: null, expiresAt: { gt: now } } };
  if (start) {
    await db.$transaction(async tx => {
    const changed = await tx.localRunnerCommand.updateMany({ where, data: { status: "executing" } });
    if (!changed.count) throw new ApiError(409, "本机命令已停止、撤销或租约已结束。");
    const current = await tx.localRunnerCommand.findUniqueOrThrow({ where: { id }, select: { executionId: true, input: true } });
    await commandProgress(tx, current.executionId, id, "Runner 已确认授权，正在启动 Docker 命令", {
      action: "command_execution", phase: "started", command: progressCommand(commandInput.parse(JSON.parse(current.input)).command),
    });
    });
  } else if (!await db.localRunnerCommand.findFirst({ where, select: { id: true } })) throw new ApiError(409, "本机命令已停止、撤销或租约已结束。");
}

export async function claimRunnerCommand(runnerId: string) {
  const owner = randomUUID(), now = new Date();
  return db.$transaction(async tx => {
    const command = await tx.localRunnerCommand.findFirst({ where: { runnerId, status: "pending", expiresAt: { gt: now }, execution: { status: "running", leaseUntil: { gt: now } } }, orderBy: { createdAt: "asc" }, include: { execution: { select: { leaseOwner: true } } } });
    if (!command) return null;
    if (command.executionLease !== command.execution.leaseOwner) {
      await tx.localRunnerCommand.update({ where: { id: command.id }, data: { status: "failed", error: "执行租约已变化，旧命令已作废。" } }); return null;
    }
    const changed = await tx.localRunnerCommand.updateMany({ where: { id: command.id, status: "pending", expiresAt: { gt: now },
      execution: { status: "running", leaseOwner: command.executionLease, leaseUntil: { gt: now } }, runner: { revokedAt: null, expiresAt: { gt: now } } }, data: { status: "claimed", leaseOwner: owner, expiresAt: new Date(Date.now() + (command.operation === "exec" ? 75_000 : 60_000)) } });
    return changed.count ? { id: command.id, executionId: command.executionId, operation: command.operation, input: JSON.parse(command.input) as unknown, leaseOwner: owner } : null;
  });
}

export async function completeRunnerCommand(runnerId: string, id: string, leaseOwner: string, result: unknown, error?: string) {
  const command = await db.localRunnerCommand.findFirst({ where: { id, runnerId, leaseOwner }, select: { executionLease: true, operation: true, status: true, input: true } });
  if (!command) throw new ApiError(409, "Runner 命令租约已结束。");
  if (command.operation === "exec" && !error) {
    const input = commandInput.parse(JSON.parse(command.input)), value = commandResult.parse(result);
    if (value.beforeHead !== input.head || JSON.stringify(value.command) !== JSON.stringify(input.command)) throw new ApiError(409, "命令回执与批准内容不一致。");
    if (value.head !== input.head && value.status === "passed") throw new ApiError(409, "命令更改了文件，请重新验证。");
    if (value.entries.length && value.status === "passed") throw new ApiError(409, "命令更改了文件，请重新验证。");
    if (command.status === "claimed" && (value.status !== "unavailable" || value.head !== input.head || value.entries.length)) throw new ApiError(409, "命令尚未获取单次启动授权。");
    if (Buffer.byteLength(JSON.stringify(value.entries)) > Math.min(input.receiptBudget, 1_000_000)) throw new ApiError(413, "命令回执超过批准的差异预算，请在本机检查实际文件。");
  }
  await db.$transaction(async tx => {
  const changed = await tx.localRunnerCommand.updateMany({ where: { id, runnerId, leaseOwner, status: { in: ["claimed", "executing"] }, expiresAt: { gt: new Date() },
    execution: { status: "running", leaseOwner: command.executionLease, leaseUntil: { gt: new Date() } }, runner: { revokedAt: null, expiresAt: { gt: new Date() } } },
    data: { status: error ? "failed" : "completed", result: error ? null : JSON.stringify(result), error: error?.slice(0, 500) } });
  if (!changed.count) throw new ApiError(409, "Runner 命令租约已结束。");
  if (command.operation === "exec") {
    const current = await tx.localRunnerCommand.findUniqueOrThrow({ where: { id }, select: { executionId: true } });
    const status = error ? "failed" : commandResult.parse(result).status;
    await commandProgress(tx, current.executionId, id,
      error ? "Runner 命令操作失败，请查看任务错误" : status === "passed" ? "Docker 命令验证通过" : status === "failed" ? "Docker 命令验证失败" : "命令未执行，请查看验证结果", {
        action: "command_execution", phase: error ? "failed" : "completed", status, command: progressCommand(commandInput.parse(JSON.parse(command.input)).command),
      });
  }
  });
}

async function runnerOperation<T>(args: { runnerId: string; executionId: string; executionLease: string; operation: string; input: unknown; signal?: AbortSignal }): Promise<T> {
  args.signal?.throwIfAborted();
  const id = randomUUID();
  const execution = await db.workspaceExecution.findUniqueOrThrow({ where: { id: args.executionId }, select: { leaseOwner: true, status: true, runnerId: true } });
  if (execution.status !== "running" || execution.leaseOwner !== args.executionLease || execution.runnerId !== args.runnerId) throw new ApiError(409, "本地执行租约无效。");
  const isExec = args.operation === "exec";
  await db.$transaction(async tx => {
  await tx.localRunnerCommand.create({ data: { id, runnerId: args.runnerId, executionId: args.executionId, executionLease: execution.leaseOwner!, operation: args.operation,
    status: isExec ? "approval" : "pending", input: JSON.stringify(args.input), expiresAt: new Date(Date.now() + (isExec ? 120_000 : 60_000)) } });
  if (isExec) await commandProgress(tx, args.executionId, id, "等待你批准本机 Docker 命令", {
    action: "command_approval", phase: "waiting", command: progressCommand(commandInput.parse(args.input).command),
  });
  });
  const until = Date.now() + (isExec ? 270_000 : 65_000);
  while (Date.now() < until) {
    args.signal?.throwIfAborted();
    const run = await db.workspaceExecution.findUnique({ where: { id: args.executionId }, select: { status: true, leaseUntil: true, leaseOwner: true } });
    if (!run || run.leaseOwner !== args.executionLease || run.status !== "running" || !run.leaseUntil || run.leaseUntil <= new Date()) throw new ApiError(409, "本地工作区任务已停止或执行租约结束。");
    const command = await db.localRunnerCommand.findUniqueOrThrow({ where: { id } });
    if (command.status === "completed") {
      const value = JSON.parse(command.result ?? "null") as T;
      await db.localRunnerCommand.update({ where: { id }, data: { input: "{}", result: null, status: "consumed" } });
      return value;
    }
    if (command.status === "failed") throw new ApiError(502, command.error ?? "本地 Runner 操作失败。");
    if (command.expiresAt <= new Date()) {
      if (isExec && ["approval", "pending"].includes(command.status)) {
        await db.$transaction(async tx => {
        const expired = await tx.localRunnerCommand.updateMany({ where: { id, status: command.status, expiresAt: { lte: new Date() } },
          data: { status: "completed", result: JSON.stringify(unexecuted(commandInput.parse(args.input), "命令未执行：审批或领取已超时，请重新提出命令。")) } });
        if (expired.count) await commandProgress(tx, args.executionId, id, "命令未执行：审批或领取已超时", {
          action: "command_approval", phase: "completed", status: "unavailable", command: progressCommand(commandInput.parse(args.input).command),
        });
        });
        continue;
      }
      throw new ApiError(504, "本地操作超时。写入可能已在本机完成，请检查目录后再恢复任务。");
    }
    await delay(200);
  }
  throw new ApiError(504, "等待本机 Runner 超时。请保持 Runner 在线后恢复任务。");
}

export class LocalRunnerWorkspace implements WorkspacePort {
  readonly local = true;
  readonly branch: string;
  private entries: DiffEntry[];
  private savedHead: string | null = null;
  constructor(readonly executionId: string, readonly runnerId: string, entriesJson: string | null, private signal?: AbortSignal, private executionLease?: string) {
    this.branch = "local/" + runnerId + "/" + executionId;
    try {
      const parsed = entriesJson ? JSON.parse(entriesJson) as DiffEntry[] | { head: string; entries: DiffEntry[] } : [];
      this.entries = Array.isArray(parsed) ? parsed : parsed.entries;
      this.savedHead = Array.isArray(parsed) ? null : parsed.head;
    } catch { this.entries = []; }
  }
  private operation<T>(operation: string, input: unknown) {
    if (!this.executionLease) throw new ApiError(409, "本地工作区只读快照不能下发命令。");
    return runnerOperation<T>({ runnerId: this.runnerId, executionId: this.executionId, executionLease: this.executionLease, operation, input, signal: this.signal });
  }
  async list(query = "") {
    const result = await this.operation<{ head: string; files: { path: string; mode: string; size: number }[]; total: number }>("list", {});
    return { ...result, files: result.files.filter(file => file.path.includes(query)) };
  }
  async read(filename: string) {
    return this.operation<{ path: string; head: string; content: string }>("read", { path: filename });
  }
  async readMany(filenames: string[]) {
    const result = await this.operation<{ head: string; entries: { path: string; content: string | null }[] }>("inspect", { paths: filenames });
    if (result.entries.length !== filenames.length || result.entries.some(entry => entry.content === null)) throw new ApiError(409, "批量验证期间文件发生变化。");
    return { head: result.head, files: result.entries.map(entry => ({ path: entry.path, content: entry.content! })) };
  }
  async runCommand(head: string, command: string[]): Promise<Verification> {
    const input = commandInput.parse({ head, command, receiptBudget: Math.max(0, 1_200_000 - Buffer.byteLength(JSON.stringify(this.entries))) });
    const result = commandResult.parse(await this.operation<unknown>("exec", input));
    if (result.beforeHead !== head || JSON.stringify(result.command) !== JSON.stringify(command)) throw new ApiError(502, "本机命令回执与审批内容不一致。");
    if (result.head !== head && result.status === "passed") throw new ApiError(502, "命令修改了文件，不能把旧快照的测试结果用于新快照。");
    for (const next of result.entries) {
      const existing = this.entries.find(entry => entry.path === next.path);
      if (existing) existing.after = next.after;
      else this.entries.push(next);
    }
    const json = JSON.stringify(this.entries);
    if (Buffer.byteLength(json) > 1_500_000) throw new ApiError(413, "命令产生的差异超过保存上限，请在本机检查实际文件。");
    await this.saveReview(result.head, json);
    return { head: result.head, command: result.command, kind: result.kind, status: result.status, output: result.output };
  }
  async write(head: string, changes: { path: string; content?: string; delete?: boolean }[], reason: string) {
    const receiptBudget = Math.max(0, 1_200_000 - Buffer.byteLength(JSON.stringify(this.entries)));
    const result = await this.operation<{ head: string; entries: DiffEntry[] }>("write", { head, changes, reason, receiptBudget });
    for (const next of result.entries) {
      const existing = this.entries.find(entry => entry.path === next.path);
      if (existing) existing.after = next.after;
      else this.entries.push(next);
    }
    const json = JSON.stringify(this.entries);
    if (Buffer.byteLength(json) > 1_500_000) throw new ApiError(413, "本任务差异超过保存上限，请拆分任务。");
    await this.saveReview(result.head, json);
    return { commit: result.head };
  }
  async diff() {
    const result = await this.operation<{ head: string; entries: { path: string; content: string | null }[] }>("inspect", { paths: this.entries.map(entry => entry.path) });
    for (const entry of this.entries) {
      const current = result.entries.find(item => item.path === entry.path);
      if (!current) throw new ApiError(502, "Runner 未返回完整的变更快照。");
      entry.after = current.content;
    }
    const head = result.head;
    await this.saveReview(head, JSON.stringify(this.entries));
    return { head, changedPaths: this.entries.filter(entry => entry.before !== entry.after).map(entry => entry.path), diff: localDiff(this.entries.filter(entry => entry.before !== entry.after)) };
  }
  private async saveReview(head: string, json: string) {
    const updated = await db.workspaceExecution.updateMany({ where: { id: this.executionId, status: "running", leaseOwner: this.executionLease, leaseUntil: { gt: new Date() } }, data: { localReview: JSON.stringify({ head, entries: JSON.parse(json) as DiffEntry[] }), head } });
    if (!updated.count) throw new ApiError(409, "本地执行租约已结束，停止保存旧任务状态。");
    this.savedHead = head;
  }
  savedReview() { return {
    head: this.savedHead,
    files: this.entries.filter(entry => entry.after !== null && entry.before !== entry.after).map(entry => ({ path: entry.path, size: Buffer.byteLength(entry.after!) })),
    changedPaths: this.entries.filter(entry => entry.before !== entry.after).map(entry => entry.path), diff: localDiff(this.entries.filter(entry => entry.before !== entry.after)),
  }; }
  async preview(path: string) { const entry = this.entries.find(item => item.path === path); if (!entry || entry.after === null) throw new ApiError(404, "任务变更文件不存在。"); return { path, content: entry.after, head: "local" }; }
}
