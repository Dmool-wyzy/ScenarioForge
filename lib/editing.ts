import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./errors";
import { appendEvent } from "./events";
import { filenameSchema } from "./validation";
import { ragEnabled } from "./rag/config";
import { saveSource } from "./rag/sources";
import { validateAndSaveCitations } from "./rag/citations";

export const lockSchema = z.object({ action: z.enum(["lock", "unlock", "renew"]), lockToken: z.string().uuid(), baseVersion: z.number().int().min(1).optional() });
export const userSaveSchema = z.object({ baseVersion: z.number().int().min(1), content: z.string().min(1).max(100000), changeNote: z.string().trim().max(1000).default("用户更新文档"), lockToken: z.string().uuid().optional() });

async function resumeAfterEdit(tx: Prisma.TransactionClient, packageId: string, message: string, always: boolean) {
  const p = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
  const locked = await tx.workspaceFile.count({ where: { packageId, lockedBy: { not: null } } });
  const blocked = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
  if ((!always && p.status !== "waiting_for_edit") || locked || blocked) {
    if (always) await tx.researchPackage.update({ where: { id: packageId }, data: { pendingMessage: [p.pendingMessage, message].filter(Boolean).join("\n") } });
    return;
  }
  const running = p.taskState === "running" && p.leaseUntil && p.leaseUntil > new Date();
  await tx.researchPackage.update({ where: { id: packageId }, data: { status: "researching", taskState: running ? "running" : "queued", pendingMessage: [p.pendingMessage, message].filter(Boolean).join("\n") } });
}

export async function updateFileLock(packageId: string, filename: string, input: unknown) {
  const name = filenameSchema.parse(filename);
  const data = lockSchema.parse(input);
  return db.$transaction(async (tx) => {
    const file = await tx.workspaceFile.findUnique({ where: { packageId_filename: { packageId, filename: name } } });
    if (!file) throw new ApiError(404, "文件尚未生成。");
    const active = file.lockedBy && file.lockExpiresAt && file.lockExpiresAt > new Date();
    if (active && file.lockToken !== data.lockToken) throw new ApiError(423, "文件已在另一个窗口编辑，请完成编辑或等待编辑锁到期。");
    if (data.action === "unlock") {
      if (!file.lockedBy) return { status: "unlocked" };
      await tx.workspaceFile.update({ where: { id: file.id }, data: { lockedBy: null, lockToken: null, lockExpiresAt: null } });
      await appendEvent(tx, packageId, "file_unlocked", `${name} 已解除编辑锁`, { filename: name });
      await resumeAfterEdit(tx, packageId, `${name} 已结束编辑，请重新读取最新文件并继续。`, false);
      return { status: "unlocked" };
    }
    if (data.action === "renew" && (!active || file.lockToken !== data.lockToken)) throw new ApiError(409, "编辑锁已过期，请保留草稿并重新进入编辑。");
    if (data.baseVersion !== undefined && data.baseVersion !== file.version) throw new ApiError(409, "文件已有新版本，请刷新后重新编辑。");
    const updated = await tx.workspaceFile.update({ where: { id: file.id }, data: { lockedBy: "user", lockToken: data.lockToken, lockExpiresAt: new Date(Date.now() + 120000) } });
    if (!active) await appendEvent(tx, packageId, "file_locked", `你正在编辑 ${name}`, { filename: name });
    return { status: "locked", file: { filename: updated.filename, content: updated.content, version: updated.version } };
  });
}

export async function saveUserFile(packageId: string, filename: string, input: unknown) {
  const name = filenameSchema.parse(filename);
  const data = userSaveSchema.parse(input);
  return db.$transaction(async (tx) => {
    const file = await tx.workspaceFile.findUnique({ where: { packageId_filename: { packageId, filename: name } } });
    if (!file) throw new ApiError(404, "文件尚未生成。");
    if (file.version !== data.baseVersion) throw new ApiError(409, "保存失败：文件已有新版本。你的编辑内容已保留，请读取最新版本后合并。");
    if (file.lockedBy && (file.lockToken !== data.lockToken || !file.lockExpiresAt || file.lockExpiresAt <= new Date())) throw new ApiError(423, "编辑锁已失效或属于另一个窗口。请保留草稿后重新进入编辑。");
    const updated = await tx.workspaceFile.updateMany({ where: { id: file.id, version: data.baseVersion, ...(file.lockedBy ? { lockToken: data.lockToken } : { lockedBy: null }) }, data: { content: data.content, userContent: data.content, version: { increment: 1 }, updatedBy: "user", changeNote: data.changeNote, lockedBy: null, lockToken: null, lockExpiresAt: null } });
    if (!updated.count) throw new ApiError(409, "保存期间文件发生变更，你的编辑内容已保留。");
    if (ragEnabled()) {
      await saveSource(tx, packageId, { sourceType: "workspace", sourceKey: `workspace:${name}`, title: name, content: data.content, metadata: { filename: name, fileVersion: file.version + 1, updatedBy: "user", trust: "user_provided" } });
      const warnings = await validateAndSaveCitations(tx, packageId, name, file.version + 1, data.content);
      if (warnings.length) await appendEvent(tx, packageId, "citation_warning", "文件已保存，部分引用编号需要核对。", { filename: name, evidenceIds: warnings });
    }
    await tx.researchPackage.update({ where: { id: packageId }, data: { contextVersion: { increment: 1 } } });
    await appendEvent(tx, packageId, "file_updated", `你保存了 ${name}`, { filename: name, version: file.version + 1, updatedBy: "user" });
    await appendEvent(tx, packageId, "file_unlocked", `${name} 已解除编辑锁`, { filename: name });
    await resumeAfterEdit(tx, packageId, `用户修改了 ${name}（版本 ${file.version + 1}）。必须调用 read_workspace_file 读取最新内容，保留全部用户修改，再更新上下文及相关文档。修改说明：${data.changeNote}`, true);
    return { status: "saved", version: file.version + 1 };
  });
}

export async function expireFileLocks() {
  const files = await db.workspaceFile.findMany({ where: { lockedBy: { not: null }, lockExpiresAt: { lte: new Date() } }, take: 100 });
  for (const file of files) {
    await db.$transaction(async (tx) => {
      const changed = await tx.workspaceFile.updateMany({ where: { id: file.id, lockToken: file.lockToken, lockExpiresAt: { lte: new Date() } }, data: { lockedBy: null, lockToken: null, lockExpiresAt: null } });
      if (!changed.count) return;
      await appendEvent(tx, file.packageId, "file_unlocked", `${file.filename} 编辑锁已到期，未保存的草稿仍保留在原窗口`, { filename: file.filename });
      await resumeAfterEdit(tx, file.packageId, `${file.filename} 编辑锁已到期，请重新读取最新文件再继续。`, false);
    });
  }
}
