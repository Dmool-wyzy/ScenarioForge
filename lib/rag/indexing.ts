import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { appendEvent, emitEvent } from "../events";
import { chunkConfig, embeddingConfig, RagError, ragEnabled } from "./config";
import { chunkText } from "./chunking";
import { embedTexts, vectorNorm } from "./embedding";

const state = globalThis as unknown as { ragIndexWork?: Map<string, Promise<string>> };
const work = state.ragIndexWork ??= new Map();
export function indexCompatible(index: { provider: string; model: string; baseUrlFingerprint: string; dimensions: number | null; chunkerVersion: string }, config = embeddingConfig()) {
  return index.provider === config.provider && index.model === config.model && index.baseUrlFingerprint === config.fingerprint &&
    (!config.dimensions || !index.dimensions || config.dimensions === index.dimensions) && index.chunkerVersion === chunkConfig().version;
}
async function targetIndex(packageId: string, rebuild: boolean) {
  const config = embeddingConfig();
  const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
  const indexes = await db.embeddingIndex.findMany({ where: { packageId }, orderBy: { generation: "desc" } });
  const active = indexes.find(index => index.id === pkg.activeIndexId);
  const building = indexes.find(index => index.status === "building" && indexCompatible(index, config));
  if (building) return building;
  if (active && !rebuild) {
    if (!indexCompatible(active, config)) throw new RagError("index_rebuild_required", "Embedding 模型、端点、维度或分块参数已变化，请重建本项目索引。", 409);
    return active;
  }
  return db.embeddingIndex.create({ data: { packageId, generation: (indexes[0]?.generation ?? 0) + 1,
    provider: config.provider, model: config.model, baseUrlFingerprint: config.fingerprint,
    dimensions: config.dimensions, chunkerVersion: chunkConfig().version } });
}
async function indexRevision(jobId: string, packageId: string, indexId: string) {
  const owner = randomUUID();
  const claimed = await db.knowledgeJob.updateMany({ where: { id: jobId, packageId, OR: [
    { status: "pending", nextAttemptAt: { lte: new Date() } }, { status: "running", leaseUntil: { lt: new Date() } },
  ] }, data: { status: "running", indexId, attempts: { increment: 1 }, leaseOwner: owner, leaseUntil: new Date(Date.now() + 180000) } });
  if (!claimed.count) return;
  const heartbeat = setInterval(() => { void db.knowledgeJob.updateMany({ where: { id: jobId, leaseOwner: owner, status: "running" }, data: { leaseUntil: new Date(Date.now() + 180000) } }).catch(() => {}); }, 30000);
  try {
    const job = await db.knowledgeJob.findFirstOrThrow({ where: { id: jobId, packageId }, include: { revision: true } });
    const chunker = chunkConfig();
    const blocks = chunkText(job.revision.rawContent, chunker.size, chunker.overlap);
    await db.$transaction(async tx => {
      const existing = await tx.evidenceChunk.count({ where: { packageId, sourceRevisionId: job.sourceRevisionId, chunkerVersion: chunker.version } });
      if (!existing) {
        const pkg = await tx.researchPackage.update({ where: { id: packageId }, data: { nextEvidenceNumber: { increment: blocks.length } }, select: { nextEvidenceNumber: true } });
        for (const [chunkIndex, block] of blocks.entries()) await tx.evidenceChunk.create({ data: { packageId, sourceRevisionId: job.sourceRevisionId, chunkerVersion: chunker.version, chunkIndex,
          evidenceNumber: pkg.nextEvidenceNumber - blocks.length + chunkIndex + 1, content: block.content, tokenCount: block.tokenCount,
          metadata: JSON.stringify({ ...JSON.parse(job.revision.metadata), ...block.metadata }) } });
      }
    });
    const chunks = await db.evidenceChunk.findMany({ where: { packageId, sourceRevisionId: job.sourceRevisionId, chunkerVersion: chunker.version }, orderBy: { chunkIndex: "asc" } });
    const config = embeddingConfig();
    for (let offset = 0; offset < chunks.length; offset += config.batchSize) {
      const batch = chunks.slice(offset, offset + config.batchSize);
      const saved = await db.chunkEmbedding.findMany({ where: { packageId, indexId, chunkId: { in: batch.map(chunk => chunk.id) } }, select: { chunkId: true } });
      const missing = batch.filter(chunk => !saved.some(row => row.chunkId === chunk.id));
      if (!missing.length) continue;
      const vectors = await embedTexts(missing.map(chunk => chunk.content), config);
      await db.$transaction(async tx => {
        const index = await tx.embeddingIndex.findFirstOrThrow({ where: { id: indexId, packageId } });
        const dimensions = vectors[0].length;
        if (index.dimensions && index.dimensions !== dimensions) throw new RagError("dimension_mismatch", "向量维度与项目索引不一致，请重建索引。", 409);
        const lease = await tx.knowledgeJob.count({ where: { id: jobId, packageId, leaseOwner: owner, status: "running" } });
        if (!lease) throw new RagError("lease_lost", "索引任务租约已失效，请稍后重试。", 409);
        await tx.embeddingIndex.update({ where: { id: indexId }, data: { dimensions } });
        for (const [i, chunk] of missing.entries()) await tx.chunkEmbedding.upsert({ where: { indexId_chunkId: { indexId, chunkId: chunk.id } }, update: {},
          create: { packageId, indexId, chunkId: chunk.id, vector: JSON.stringify(vectors[i]), vectorNorm: vectorNorm(vectors[i]) } });
      });
    }
    await db.$transaction(async tx => {
      const updated = await tx.knowledgeJob.updateMany({ where: { id: jobId, leaseOwner: owner }, data: { status: "completed", errorCode: null, leaseOwner: null, leaseUntil: null } });
      if (updated.count) await appendEvent(tx, packageId, "evidence_indexed", `证据已索引：${chunks.length} 个分块`, { revisionId: job.sourceRevisionId, indexId, chunkCount: chunks.length });
    });
  } catch (error) {
    const code = error instanceof RagError ? error.code : "index_failed";
    const job = await db.knowledgeJob.findUniqueOrThrow({ where: { id: jobId } });
    const retryable = code === "embedding_unavailable" && job.attempts < 3;
    await db.$transaction(async tx => {
      const result = await tx.knowledgeJob.updateMany({ where: { id: jobId, leaseOwner: owner }, data: { status: retryable ? "pending" : "failed", errorCode: code, leaseOwner: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 30000 * job.attempts) } });
      if (!retryable) await tx.knowledgeJob.updateMany({ where: { packageId, sourceRevisionId: job.sourceRevisionId, indexId: null }, data: { status: "failed", errorCode: code } });
      if (result.count) await appendEvent(tx, packageId, "index_failed", error instanceof RagError ? error.message : "索引暂时失败，原始资料已保留。", { code, jobId, retryable });
    });
    throw error;
  } finally { clearInterval(heartbeat); }
}

export function processPackageIndex(packageId: string, options: { rebuild?: boolean; retry?: boolean } = {}): Promise<string> {
  const current = work.get(packageId);
  if (current) return current;
  const promise = (async () => {
    const index = await targetIndex(packageId, !!options.rebuild);
    const sources = await db.source.findMany({ where: { packageId, currentRevisionId: { not: null } }, select: { currentRevisionId: true } });
    for (const source of sources) {
      const sourceRevisionId = source.currentRevisionId!;
      const key = `${index.id}:${sourceRevisionId}`;
      await db.knowledgeJob.upsert({ where: { jobKey: key }, update: options.retry ? { status: "pending", attempts: 0, nextAttemptAt: new Date(), errorCode: null } : {}, create: { packageId, indexId: index.id, sourceRevisionId, jobKey: key } });
      const job = await db.knowledgeJob.findUniqueOrThrow({ where: { jobKey: key } });
      if (job.status !== "completed") await indexRevision(job.id, packageId, index.id);
    }
    const ids = sources.map(source => source.currentRevisionId!);
    await db.$transaction(async tx => {
      const incomplete = await tx.knowledgeJob.count({ where: { packageId, indexId: index.id, sourceRevisionId: { in: ids }, status: { not: "completed" } } });
      const nowSources = await tx.source.findMany({ where: { packageId, currentRevisionId: { not: null } }, select: { currentRevisionId: true } });
      if (incomplete || nowSources.length !== ids.length || nowSources.some(source => !ids.includes(source.currentRevisionId!)))
        throw new RagError("index_not_ready", "知识库仍有资料等待索引，请稍后重试。", 409);
      await tx.embeddingIndex.update({ where: { id: index.id }, data: { status: "ready", errorCode: null, activatedAt: new Date() } });
      await tx.researchPackage.update({ where: { id: packageId }, data: { activeIndexId: index.id } });
      await tx.embeddingIndex.updateMany({ where: { packageId, id: { not: index.id }, status: "building" }, data: { status: "superseded" } });
      await tx.knowledgeJob.updateMany({ where: { packageId, indexId: { not: index.id }, status: { in: ["pending", "running", "failed"] } }, data: { status: "superseded", leaseOwner: null, leaseUntil: null } });
      await tx.knowledgeJob.updateMany({ where: { packageId, indexId: index.id, sourceRevisionId: { notIn: ids }, status: { in: ["pending", "running", "failed"] } }, data: { status: "superseded", leaseOwner: null, leaseUntil: null } });
      await tx.knowledgeJob.updateMany({ where: { packageId, indexId: null }, data: { status: "completed" } });
    });
    return index.id;
  })().catch(async error => {
    if (error instanceof RagError && error.code === "index_rebuild_required") {
      await db.knowledgeJob.updateMany({ where: { packageId, status: { in: ["pending", "running"] } }, data: { status: "blocked", errorCode: error.code, leaseOwner: null, leaseUntil: null } });
      await emitEvent(packageId, "index_rebuild_required", error.message, { code: error.code });
    }
    throw error;
  }).finally(() => { work.delete(packageId); });
  work.set(packageId, promise);
  return promise;
}

export async function queueRebuild(packageId: string) {
  if (!ragEnabled()) throw new RagError("rag_disabled", "请先配置 Embedding 并设置 RAG_ENABLED=true 后重建索引。", 409);
  embeddingConfig();
  // Explicit rebuild is allowed to use embeddings. A durable generation and jobs
  // are written before scheduling, so a restart can recover this request.
  const index = await targetIndex(packageId, true);
  const sources = await db.source.findMany({ where: { packageId, currentRevisionId: { not: null } } });
  for (const source of sources) await db.knowledgeJob.upsert({ where: { jobKey: `${index.id}:${source.currentRevisionId}` }, update: { status: "pending", attempts: 0, nextAttemptAt: new Date(), errorCode: null },
    create: { packageId, indexId: index.id, sourceRevisionId: source.currentRevisionId!, jobKey: `${index.id}:${source.currentRevisionId}` } });
  return { status: "queued", indexId: index.id };
}
