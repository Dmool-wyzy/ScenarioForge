import "server-only";
import { z } from "zod";
import { db } from "../db";
import { emitEvent } from "../events";
import { embeddingConfig, retrievalConfig, RagError } from "./config";
import { embedTexts } from "./embedding";
import { indexCompatible } from "./indexing";
import { vectorStore } from "./vector-store";
import { SOURCE_TYPES, type RetrievalResult } from "./types";

export const retrievalSchema = z.object({ query: z.string().trim().min(1).max(2000), topK: z.number().int().min(1).max(20).optional(), sourceTypes: z.array(z.enum(SOURCE_TYPES)).min(1).max(4).optional() });
export async function searchEvidence(packageId: string, input: unknown): Promise<RetrievalResult> {
  const started = Date.now();
  const data = retrievalSchema.parse(input);
  const settings = retrievalConfig();
  const topK = data.topK ?? settings.topK;
  try {
  const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, select: { activeIndexId: true } });
  const index = pkg.activeIndexId ? await db.embeddingIndex.findFirst({ where: { id: pkg.activeIndexId, packageId } }) : null;
  let result: RetrievalResult;
  if (!index) result = { status: "index_not_ready", message: "项目证据尚未建立向量索引，请先完成配置并建立索引。", results: [], indexId: null, durationMs: 0 };
  else if (!indexCompatible(index, embeddingConfig())) result = { status: "index_rebuild_required", message: "Embedding 配置已变化，请重建本项目索引后检索。", results: [], indexId: index.id, durationMs: 0 };
  else {
    const vector = (await embedTexts([data.query]))[0];
    if (vector.length !== index.dimensions) throw new RagError("dimension_mismatch", "查询向量与索引维度不同，请重建索引。", 409);
    const candidates = await vectorStore.search(packageId, index.id, vector, topK, settings.minScore, data.sourceTypes);
    let remaining = settings.maxChars;
    const results = candidates.flatMap(hit => {
      if (remaining < 100) return [];
      const content = hit.content.slice(0, remaining);
      remaining -= content.length;
      return [{ ...hit, content, metadata: { ...hit.metadata, truncated: content.length < hit.content.length } }];
    });
    result = { status: results.length ? "ok" : "insufficient_evidence", message: results.length ? "已检索到相关项目证据。" : "证据不足：没有达到相关性阈值的资料，请补充资料或标记待确认。", results, indexId: index.id, durationMs: 0 };
  }
  result.durationMs = Date.now() - started;
  const log = await db.retrievalLog.create({ data: { packageId, query: data.query, topK, sourceTypes: JSON.stringify(data.sourceTypes ?? []), indexId: result.indexId,
    resultEvidenceIds: JSON.stringify(result.results.map(hit => hit.evidenceId)), scores: JSON.stringify(result.results.map(hit => hit.score)), durationMs: result.durationMs, status: result.status } });
  await emitEvent(packageId, "retrieval_completed", `项目证据检索：${result.results.length} 条相关分块`, { query: data.query, topK, evidenceIds: result.results.map(hit => hit.evidenceId), durationMs: result.durationMs, status: result.status });
  return { ...result, retrievalId: log.id };
  } catch (error) {
    const code = error instanceof RagError ? error.code : "retrieval_failed";
    await db.retrievalLog.create({ data: { packageId, query: data.query, topK, sourceTypes: JSON.stringify(data.sourceTypes ?? []), resultEvidenceIds: "[]", scores: "[]", durationMs: Date.now() - started, status: code } }).catch(() => {});
    throw error;
  }
}

export async function getEvidence(packageId: string, evidenceId: string) {
  const match = /^EVIDENCE-([1-9]\d*)$/.exec(evidenceId);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new RagError("invalid_input", "证据编号格式应为 EVIDENCE-数字。", 400);
  const chunk = await db.evidenceChunk.findUnique({ where: { packageId_evidenceNumber: { packageId, evidenceNumber: Number(match[1]) } }, include: { revision: { include: { source: true } }, citations: { where: { packageId } } } });
  if (!chunk) throw new RagError("not_found", "当前研究包中不存在该证据。", 404);
  const { revision } = chunk;
  const metadata = JSON.parse(revision.metadata);
  return { evidenceId, content: chunk.content, chunkIndex: chunk.chunkIndex, metadata: JSON.parse(chunk.metadata), source: { id: revision.source.id, type: revision.source.sourceType, title: metadata.title ?? revision.source.title,
    url: metadata.url ?? null, fetchedAt: revision.fetchedAt, revision: revision.revision, current: revision.source.currentRevisionId === revision.id }, citations: chunk.citations.map(({ documentName, fileVersion, section }) => ({ documentName, fileVersion, section })) };
}

export async function listEvidence(packageId: string, input: { sourceType?: string; page?: string }) {
  const sourceType = input.sourceType ? z.enum(SOURCE_TYPES).parse(input.sourceType) : undefined;
  const page = z.coerce.number().int().min(1).max(100000).parse(input.page ?? 1);
  const where = { packageId, ...(sourceType ? { revision: { source: { sourceType } } } : {}) };
  const [rows, total] = await Promise.all([
    db.evidenceChunk.findMany({ where, orderBy: { evidenceNumber: "asc" }, skip: (page - 1) * 20, take: 20, include: { revision: { include: { source: true } } } }),
    db.evidenceChunk.count({ where }),
  ]);
  return { page, total, pageSize: 20, results: rows.map(row => ({ evidenceId: `EVIDENCE-${row.evidenceNumber}`, content: row.content.slice(0, 260), chunkIndex: row.chunkIndex,
    source: { type: row.revision.source.sourceType, title: row.revision.source.title, url: row.revision.source.url, current: row.revision.source.currentRevisionId === row.revision.id }, metadata: JSON.parse(row.metadata) })) };
}
