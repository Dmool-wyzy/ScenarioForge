import "server-only";
import { z } from "zod";
import { ApiError } from "./errors";

export const goalSchema = z.string().trim().min(5).max(5000);
export const constraintsSchema = z.object({ deadline: z.string().max(200).optional(), teamSize: z.coerce.number().int().min(1).max(1000).optional(), budget: z.string().max(200).optional(), techPreference: z.string().max(500).optional() });
export const uploadedTextSchema = z.object({ filename: z.string().min(1).max(150).regex(/^[^/\\\u0000-\u001f]+\.(md|txt|pdf|docx)$/i), extractedText: z.string().max(20000) });
export const createSchema = z.object({ goal: goalSchema, constraints: constraintsSchema.optional(), files: z.array(uploadedTextSchema).max(5).default([]) });
export const filenameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}\.md$/, "文件名须为根目录下的 Markdown 文件，使用英文字母、数字、下划线或连字符。").refine((name) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\.md$/i.test(name), "文件名不可使用系统保留名称。");
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  // Next.js normalizes loopback addresses to localhost in request.url.
  // Host retains the address the browser actually used.
  const host = request.headers.get("host");
  if (host) url.host = host;
  if (origin !== url.origin) throw new ApiError(403, "请求来源无效。");
}
export async function readBytes(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "请求内容不能为空。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel(); throw new ApiError(413, "请求内容过大。"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(request: Request, maxBytes = 1_000_000): Promise<unknown> {
  try { return JSON.parse((await readBytes(request, maxBytes)).toString("utf8")); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, "请求必须是有效的 JSON。"); }
}
