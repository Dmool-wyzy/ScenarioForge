import "server-only";
import { z } from "zod";

// Validate normalized evidence sources crossing the MCP/backend boundary.
export const sourceSchema = z.object({
  title: z.string().max(500),
  url: z.url().refine((url) => /^https?:\/\//i.test(url)),
  snippet: z.string().max(3000),
  publishedDate: z.string().max(100).optional(),
  accessedAt: z.iso.datetime({ offset: true }),
});

export function extractUrls(content: string) {
  return (content.match(/https?:\/\/[^\s<>\)\]"']+/g) ?? []).map((url) => url.replace(/[\/.,，。；;]+$/, ""));
}
