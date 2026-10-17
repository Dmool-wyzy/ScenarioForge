import "server-only";
import { db } from "../db";
import { vectorNorm } from "./embedding";
import type { EvidenceHit, SourceType } from "./types";

export interface VectorStore {
  search(packageId: string, indexId: string, vector: number[], topK: number, minScore: number, sourceTypes?: SourceType[]): Promise<EvidenceHit[]>;
}
export function cosineSimilarity(a: number[], b: number[], bNorm = vectorNorm(b)) {
  if (a.length !== b.length) return -1;
  const norm = vectorNorm(a) * bNorm;
  return norm ? Math.max(-1, Math.min(1, a.reduce((sum, value, index) => sum + value * b[index], 0) / norm)) : -1;
}
export const vectorStore: VectorStore = {
  async search(packageId, indexId, vector, topK, minScore, sourceTypes) {
    const best: EvidenceHit[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.chunkEmbedding.findMany({ where: { packageId, indexId,
        ...(sourceTypes?.length ? { chunk: { revision: { source: { sourceType: { in: sourceTypes } } } } } : {}) },
        take: 200, orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { chunk: { include: { revision: { include: { source: true } } } } } });
      if (!rows.length) break;
      cursor = rows.at(-1)!.id;
      for (const row of rows) {
        const { chunk } = row;
        const revision = chunk.revision, source = revision.source;
        if (source.packageId !== packageId || revision.packageId !== packageId || source.currentRevisionId !== revision.id) continue;
        const score = cosineSimilarity(vector, JSON.parse(row.vector), row.vectorNorm);
        if (score < minScore) continue;
        const metadata = JSON.parse(revision.metadata);
        const hit: EvidenceHit = { evidenceId: `EVIDENCE-${chunk.evidenceNumber}`, chunkId: chunk.id, content: chunk.content, chunkIndex: chunk.chunkIndex, score,
          source: { id: source.id, type: source.sourceType as SourceType, title: metadata.title ?? source.title, url: metadata.url ?? null, fetchedAt: revision.fetchedAt.toISOString(), metadata }, metadata: JSON.parse(chunk.metadata) };
        // Prefer diverse sources but allow multiple sections of a source when
        // there are fewer sources than the requested topK.
        best.push(hit); best.sort((a, b) => b.score - a.score);
        if (best.length > topK * 4) best.length = topK * 4;
      }
    }
    const distinct = best.filter((hit, index) => best.findIndex(other => other.source.id === hit.source.id) === index).slice(0, topK);
    for (const hit of best) if (distinct.length < topK && !distinct.some(other => other.chunkId === hit.chunkId)) distinct.push(hit);
    return distinct;
  },
};
