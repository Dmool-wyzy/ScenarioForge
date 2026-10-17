import "server-only";
import { db } from "../db";
import { embeddingConfig, RagError, ragEnabled } from "./config";
import { indexCompatible, processPackageIndex } from "./indexing";

export async function knowledgeStatus(packageId: string) {
  const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
  const [sources, chunks, index, failedJobs, pendingJobs, lastJob] = await Promise.all([
    db.source.count({ where: { packageId } }), db.evidenceChunk.count({ where: { packageId } }),
    pkg.activeIndexId ? db.embeddingIndex.findFirst({ where: { id: pkg.activeIndexId, packageId } }) : null,
    db.knowledgeJob.count({ where: { packageId, status: "failed" } }),
    db.knowledgeJob.count({ where: { packageId, status: { in: ["pending", "running"] } } }),
    db.knowledgeJob.findFirst({ where: { packageId, status: "completed", indexId: { not: null } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
  ]);
  const vectors = index ? await db.chunkEmbedding.count({ where: { packageId, indexId: index.id } }) : 0;
  let status = index ? "ready" : "not_indexed", message = index ? "项目知识库可检索。" : "资料尚未建立向量索引。";
  let configuredModel: string | null = null;
  try {
    const config = embeddingConfig(); configuredModel = config.model;
    if (index && !indexCompatible(index, config)) { status = "index_rebuild_required"; message = "Embedding 配置已变化，请重建索引。"; }
    else if (pendingJobs) { status = "indexing"; message = "有资料正在等待索引。"; }
    else if (failedJobs) { status = "index_failed"; message = "部分资料索引失败，可重试；原始内容已保留。"; }
  } catch (error) { status = "missing_config"; message = error instanceof RagError ? error.message : "Embedding 尚未配置。"; }
  return { enabled: ragEnabled(), status, message, sourceCount: sources, chunkCount: chunks, vectorCount: vectors,
    model: index?.model ?? configuredModel, configuredModel, dimensions: index?.dimensions ?? null, generation: index?.generation ?? null,
    failedJobs, pendingJobs, lastIndexedAt: lastJob?.updatedAt ?? null };
}

let workerRunning = false;
export async function tickKnowledgeJobs() {
  if (!ragEnabled() || workerRunning) return;
  try { embeddingConfig(); } catch { return; }
  workerRunning = true;
  try {
  const job = await db.knowledgeJob.findFirst({ where: { OR: [ { status: "pending", nextAttemptAt: { lte: new Date() } }, { status: "running", leaseUntil: { lt: new Date() } } ] }, orderBy: { createdAt: "asc" } });
  if (!job) return;
  await processPackageIndex(job.packageId);
  }
  catch { /* Each claimed job persists its own safe error and retry state. */ }
  finally { workerRunning = false; }
}
