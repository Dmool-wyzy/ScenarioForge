import "server-only";
import { z } from "zod";
import { db } from "./db";
import { appendEvent } from "./events";
import { filenameSchema } from "./validation";
import { ApiError } from "./errors";
import { extractUrls } from "./search/sources";
import { readFilePlan } from "./file-plan";
import { completedSearchQuestions } from "./search/progress";
import { ragEnabled, RagError } from "./rag/config";
import { saveSource } from "./rag/sources";
import { validateAndSaveCitations } from "./rag/citations";

export const writeFileSchema = z.object({ filename: filenameSchema, content: z.string().min(1).max(100000), base_version: z.number().int().min(0), reason: z.string().trim().min(1).max(1000),
  rag: z.object({ retrievalId: z.string(), contextVersion: z.number().int() }).optional() });

export async function writeWorkspaceFile(packageId: string, input: unknown) {
  const data = writeFileSchema.parse(input);
  return db.$transaction(async (tx) => {
    const pkg = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId }, include: { evidence: true, events: { where: { type: { in: ["search_started", "search_completed", "search_failed"] } }, orderBy: { sequence: "asc" } } } });
    const plan = pkg.researchPlan ? JSON.parse(pkg.researchPlan) as { researchQuestions: string[] } : null;
    const searched = completedSearchQuestions(pkg.events);
    if (!plan || !pkg.evidence.length || plan.researchQuestions.some((q) => !searched.has(q.trim()))) throw new ApiError(409, "必须先完成研究问题规划、逐项检索并保存证据，才能写入工作区。");
    const filePlan = readFilePlan(plan);
    if (!filePlan.some((item) => item.filename === data.filename)) throw new ApiError(409, "写入前必须先公布文件计划，并将该文件列入计划（名称、用途、优先级、内容要点）。");
    const blocking = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
    if (blocking) return { status: "waiting_for_user", filename: data.filename };
    const file = await tx.workspaceFile.findUnique({ where: { packageId_filename: { packageId, filename: data.filename } } });
    if (file?.lockedBy) {
      await tx.researchPackage.update({ where: { id: packageId }, data: { status: "waiting_for_edit" } });
      return { status: "locked", filename: data.filename, version: file.version, instruction: "用户正在编辑，请等待解锁后重新读取最新版本。" };
    }
    if ((file?.version ?? 0) !== data.base_version) return { status: "conflict", filename: data.filename, version: file?.version ?? 0, instruction: "版本已变更，必须重新读取最新文件并保留用户修改。" };
    if (file?.userContent && !data.content.includes(file.userContent)) return { status: "user_modified", filename: data.filename, version: file.version };
    const allowed = new Set(pkg.evidence.flatMap((e) => (JSON.parse(e.sources) as { url: string }[]).flatMap((s) => extractUrls(s.url))));
    for (const url of extractUrls(file?.userContent ?? "")) allowed.add(url);
    if (ragEnabled()) {
      const sources = await tx.source.findMany({ where: { packageId }, select: { url: true } });
      for (const source of sources) for (const url of extractUrls(source.url ?? "")) allowed.add(url);
    }
    if (extractUrls(data.content).some((url) => !allowed.has(url))) throw new ApiError(409, "文件包含不在研究证据中的链接。请先检索来源，或将未知事实标为待确认。");
    const version = (file?.version ?? 0) + 1;
    if (ragEnabled()) {
      if (!data.rag) throw new RagError("retrieval_required", "请先获取此文件的 RAG 上下文，再使用返回的 rag 信息保存文件。", 409);
      if (data.rag.contextVersion !== pkg.contextVersion) throw new RagError("context_changed", "资料或澄清已更新，请重新检索上下文后生成文件。", 409);
      const retrieval = await tx.retrievalLog.findFirst({ where: { id: data.rag.retrievalId, packageId, indexId: pkg.activeIndexId } });
      if (!retrieval || !retrieval.query.startsWith(`${data.filename}: `)) throw new RagError("retrieval_required", "该文件的检索上下文无效，请重新检索。", 409);
      await validateAndSaveCitations(tx, packageId, data.filename, version, data.content, JSON.parse(retrieval.resultEvidenceIds), true);
    }
    if (file) {
      if (file.userContent && !data.content.includes(file.userContent)) return { status: "user_modified", filename: data.filename, version: file.version, instruction: "必须保留用户最后保存的全部内容，可以在其后补充建议。" };
      const updated = await tx.workspaceFile.updateMany({ where: { id: file.id, version: data.base_version, lockedBy: null }, data: { content: data.content, version, updatedBy: "agent", changeNote: data.reason, contextVersionUsed: data.rag?.contextVersion } });
      if (!updated.count) return { status: "conflict", filename: data.filename, version: file.version };
    } else {
      await tx.workspaceFile.create({ data: { packageId, filename: data.filename, content: data.content, version, updatedBy: "agent", changeNote: data.reason, contextVersionUsed: data.rag?.contextVersion } });
    }
    if (ragEnabled()) await saveSource(tx, packageId, { sourceType: "workspace", sourceKey: `workspace:${data.filename}`, title: data.filename, content: data.content,
      metadata: { filename: data.filename, fileVersion: version, updatedBy: "agent", trust: "ai_analysis", origin: /DECISION/.test(data.filename) ? "agent_decision" : "workspace" } });
    await appendEvent(tx, packageId, file ? "file_updated" : "file_created", `${file ? "更新" : "生成"} ${data.filename}`, { filename: data.filename, version, updatedBy: "agent" });
    return { status: file ? "updated" : "created", filename: data.filename, version };
  });
}

export async function readWorkspaceFile(packageId: string, filename: string) {
  const name = filenameSchema.parse(filename);
  const file = await db.workspaceFile.findUnique({ where: { packageId_filename: { packageId, filename: name } } });
  if (!file) return { filename: name, content: "", version: 0, updatedBy: null, changeNote: null, lockedBy: null };
  const { content, version, updatedBy, changeNote, lockedBy, updatedAt, userContent } = file;
  return { filename: name, content, version, updatedBy, changeNote, lockedBy, updatedAt, userModified: !!userContent };
}

export async function requireFile(packageId: string, filename: string) {
  const file = await readWorkspaceFile(packageId, filename);
  if (!file.version) throw new ApiError(404, "该文件尚未生成。");
  return file;
}
