import "server-only";
import { createHash } from "node:crypto";
import { ApiError } from "../errors";

export class RagError extends ApiError {
  constructor(public code: string, message: string, status = 503) { super(status, message); }
}
export function ragEnabled() { return process.env.RAG_ENABLED === "true"; }
function number(name: string, fallback: number, min: number, max: number, integer = true) {
  const value = process.env[name]?.trim() ? Number(process.env[name]) : fallback;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max)
    throw new RagError("missing_config", `${name} 必须为 ${min}–${max} 的${integer ? "整数" : "数值"}。`);
  return value;
}
export function chunkConfig() {
  const size = number("RAG_CHUNK_SIZE", 800, 500, 1000);
  const overlap = number("RAG_CHUNK_OVERLAP", 120, 0, 200);
  if (overlap < size * 0.1 || overlap > size * 0.2) throw new RagError("missing_config", "RAG_CHUNK_OVERLAP 必须为 chunk 大小的 10%–20%。");
  return { size, overlap, version: `markdown-v1:${size}:${overlap}` };
}
export function retrievalConfig() {
  return { topK: number("RAG_TOP_K", 5, 1, 20), minScore: number("RAG_MIN_SCORE", 0.25, -1, 1, false), maxChars: number("RAG_MAX_CONTEXT_CHARS", 10000, 1000, 30000) };
}
export function embeddingConfig() {
  const provider = process.env.EMBEDDING_PROVIDER?.trim() || "openai_compatible";
  if (provider !== "openai_compatible" && provider !== "mock") throw new RagError("missing_config", "EMBEDDING_PROVIDER 请选择 openai_compatible 或 mock（仅测试）。");
  const model = provider === "mock" ? "fixture-hash-v1" : process.env.EMBEDDING_MODEL?.trim();
  const baseURL = provider === "mock" ? "mock://local" : process.env.EMBEDDING_BASE_URL?.trim();
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  if (!model || !baseURL || (provider !== "mock" && (!apiKey || /^(sk-your-|replace-with-)/.test(apiKey))))
    throw new RagError("missing_config", "请单独配置 EMBEDDING_BASE_URL、EMBEDDING_API_KEY 和 EMBEDDING_MODEL；不会自动使用系统聊天 key。");
  if (provider !== "mock") {
    try { const url = new URL(baseURL); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { throw new RagError("missing_config", "EMBEDDING_BASE_URL 必须是无凭据、查询参数或片段的 HTTP(S) API 地址。"); }
  }
  const dimensions = provider === "mock" ? 256 : process.env.EMBEDDING_DIMENSIONS?.trim() ? number("EMBEDDING_DIMENSIONS", 0, 1, 8192) : undefined;
  return { provider, model, baseURL, apiKey, dimensions, batchSize: number("EMBEDDING_BATCH_SIZE", 16, 1, 64), timeout: number("EMBEDDING_TIMEOUT_MS", 30000, 1000, 120000), fingerprint: createHash("sha256").update(baseURL.replace(/\/$/, "")).digest("hex") };
}
