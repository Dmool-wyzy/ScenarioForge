import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { RagError } from "./config";
import { addSource, sourceKeyForUrl } from "./sources";

export function isPublicIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}
async function fetchText(value: string, redirects = 0): Promise<{ text: string; url: string; type: string }> {
  if (redirects > 4) throw new RagError("fetch_failed", "链接重定向次数过多。", 400);
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new RagError("invalid_url", "仅支持公开 HTTP/HTTPS 网页地址和标准端口。", 400);
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new RagError("fetch_failed", "链接域名解析超时。", 502)), 15000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(row => !isPublicIPv4(row.address))) throw new RagError("blocked_url", "不允许抓取本机、内网或保留地址。", 400);
  // Pin the validated IP for the connection, including after every redirect.
  const response = await new Promise<{ status: number; location?: string; type: string; text: string }>((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
      headers: { "User-Agent": "ScenarioForge/1.0", Accept: "text/html,text/plain,text/markdown", "Accept-Encoding": "identity" },
    }, res => {
      const type = String(res.headers["content-type"] ?? "").split(";")[0];
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { res.resume(); resolve({ status: res.statusCode!, location: res.headers.location, type, text: "" }); return; }
      if (res.statusCode !== 200 || !["text/html", "text/plain", "text/markdown"].includes(type)) { res.resume(); reject(new RagError("fetch_failed", "网页未返回可读取的 HTML 或文本。", 502)); return; }
      const parts: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) { req.destroy(); reject(new RagError("source_too_large", "网页超过 2MB 限制。", 413)); } else parts.push(chunk); });
      res.on("end", () => resolve({ status: 200, type, text: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), 15000);
    req.once("close", () => clearTimeout(deadline));
    req.on("error", reject); req.end();
  });
  if (response.location) return fetchText(new URL(response.location, url).toString(), redirects + 1);
  if (response.status !== 200) throw new RagError("fetch_failed", "网页重定向缺少目标地址。", 502);
  return { text: response.text, url: url.toString(), type: response.type };
}
export async function ingestLink(packageId: string, input: unknown) {
  const data = z.object({ url: z.string().url().max(2000), title: z.string().trim().min(1).max(300).optional() }).parse(input);
  try {
    const fetched = await fetchText(data.url);
    const title = data.title ?? /<title[^>]*>([^<]*)<\/title>/i.exec(fetched.text)?.[1]?.trim() ?? new URL(fetched.url).hostname;
    const text = fetched.type === "text/html" ? fetched.text.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : fetched.text;
    if (text.trim().length < 30) throw new RagError("empty_source", "未提取到足够正文，请上传文本资料。", 422);
    return await addSource(packageId, { sourceType: "web", sourceKey: sourceKeyForUrl(fetched.url), title: title.slice(0, 300), url: fetched.url, content: text.slice(0, 100000), metadata: { contentType: "fetched_text", trust: "external_unverified", truncated: text.length > 100000 } });
  } catch (error) { if (error instanceof RagError) throw error; throw new RagError("fetch_failed", "链接抓取失败或超时，未调用生成模型；请检查地址或上传正文。", 502); }
}
