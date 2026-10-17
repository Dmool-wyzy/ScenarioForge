import "server-only";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { embeddingConfig, RagError } from "./config";

export function vectorNorm(vector: number[]) { return Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)); }
export function validateVectors(vectors: unknown, count: number, dimensions?: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new RagError("invalid_embedding", "Embedding 返回的向量数量与输入不一致。", 502);
  let dimension = dimensions;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || vector.some(n => typeof n !== "number" || !Number.isFinite(n)) || !Number.isFinite(vectorNorm(vector)) || vectorNorm(vector) === 0)
      throw new RagError("invalid_embedding", "Embedding 返回了无效或零向量。", 502);
    dimension ??= vector.length;
    if (dimension !== vector.length) throw new RagError("dimension_mismatch", "Embedding 维度变化，请检查模型配置并重建索引。", 409);
  }
  return vectors;
}
function mockVector(text: string, dimensions: number) {
  const result = Array<number>(dimensions).fill(0);
  const terms = text.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]/gu) ?? [];
  for (let i = 0; i < terms.length; i++) {
    for (const term of [terms[i], ...(i + 1 < terms.length ? [`${terms[i]}${terms[i + 1]}`] : [])]) {
      const digest = createHash("sha256").update(term).digest();
      result[digest.readUInt16LE(0) % dimensions] += digest[2] % 2 ? 1 : -1;
    }
  }
  if (!vectorNorm(result)) result[0] = 1;
  const norm = vectorNorm(result);
  return result.map(value => value / norm);
}
export async function embedTexts(texts: string[], config = embeddingConfig()): Promise<number[][]> {
  if (!texts.length || texts.some(text => !text.trim())) throw new RagError("invalid_input", "向量化内容不能为空。", 400);
  if (config.provider === "mock") return texts.map(text => mockVector(text, config.dimensions!));
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey!, timeout: config.timeout, maxRetries: 0 });
  const vectors: number[][] = [];
  try {
    for (let offset = 0; offset < texts.length; offset += config.batchSize) {
      const batch = texts.slice(offset, offset + config.batchSize);
      const response = await client.embeddings.create({ model: config.model, input: batch, encoding_format: "float", ...(config.dimensions ? { dimensions: config.dimensions } : {}) });
      const data = [...response.data].sort((a, b) => a.index - b.index);
      if (data.some((item, index) => item.index !== index)) throw new RagError("invalid_embedding", "Embedding 返回的输入索引无效。", 502);
      vectors.push(...validateVectors(data.map(item => item.embedding), batch.length, config.dimensions ?? vectors[0]?.length));
    }
    return vectors;
  } catch (error) {
    if (error instanceof RagError) throw error;
    throw new RagError("embedding_unavailable", "Embedding 调用失败，请检查独立 key、模型、服务地址和网络；已保存内容可稍后重试索引。", 502);
  }
}
