export const SOURCE_TYPES = ["web", "upload", "workspace", "clarification"] as const;
export type SourceType = typeof SOURCE_TYPES[number];
export type Metadata = Record<string, unknown>;
export type EvidenceHit = {
  evidenceId: string; chunkId: string; content: string; chunkIndex: number; score: number;
  source: { id: string; type: SourceType; title: string; url: string | null; fetchedAt: string; metadata: Metadata };
  metadata: Metadata;
};
export type RetrievalResult = {
  retrievalId?: string;
  status: "ok" | "insufficient_evidence" | "index_not_ready" | "index_rebuild_required";
  message: string; results: EvidenceHit[]; indexId: string | null; durationMs: number;
};
