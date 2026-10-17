import "server-only";
import { db } from "../db";
import { filenameSchema } from "../validation";
import { readResearchPlan } from "../research-plan";
import { backfillPackage } from "./backfill";
import { processPackageIndex } from "./indexing";
import { searchEvidence } from "./retrieval";
import { RagError } from "./config";

export async function prepareFileContext(packageId: string, filename: string) {
  filenameSchema.parse(filename);
  const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
  const plan = readResearchPlan(pkg.researchPlan);
  const filePlan = plan?.filePlan.find(file => file.filename === filename);
  if (!filePlan) throw new RagError("file_not_planned", "请先将文件列入当前文件计划。", 409);
  if (!await db.source.count({ where: { packageId } })) await backfillPackage(packageId);
  await processPackageIndex(packageId);
  const before = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, select: { contextVersion: true } });
  const query = `${filename}: ${filePlan.purpose} ${filePlan.contentOutline.join(" ")}`.slice(0, 2000);
  const retrieval = await searchEvidence(packageId, { query });
  if (!["ok", "insufficient_evidence"].includes(retrieval.status)) throw new RagError(retrieval.status, retrieval.message, 409);
  const latest = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, include: { files: { where: { filename } }, clarifications: true } });
  const file = latest.files[0];
  const newestMaterial = await db.source.findFirst({ where: { packageId, sourceType: { not: "workspace" } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
  if (before.contextVersion !== latest.contextVersion) throw new RagError("context_changed", "资料已更新，请重新检索文件上下文。", 409);
  return { goal: latest.goal, constraints: JSON.parse(latest.constraints ?? "{}"), filePlan, retrieval,
    alreadyCurrent: !!(file?.contextVersionUsed != null && newestMaterial && file.updatedAt >= newestMaterial.updatedAt),
    previousFile: file ? { filename, content: file.content.slice(0, 16000), version: file.version, lockedBy: file.lockedBy, userModified: !!file.userContent } : null,
    clarifications: latest.clarifications.map(row => ({ question: row.question, answer: row.answer, status: row.status, answeredBy: row.answeredBy })),
    rag: { retrievalId: retrieval.retrievalId!, contextVersion: latest.contextVersion },
    citationRules: "事实引用 [EVIDENCE-n]，只使用本次检索中的编号。检索相关性不等于事实可靠；网页摘要不是全文，AI 分析和超时默认假设不是独立事实。证据不足写 > ⚠️ 待确认：当前证据不足以判断……。推荐须标为 AI 分析，未确认假设须标明。" };
}
