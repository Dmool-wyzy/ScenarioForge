import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as httpFetch } from "undici";
import { ApiError } from "./errors";
import { modelRequestIsStreaming } from "./model-response";
import { isPublicIPv4 } from "./rag/fetch-source";

function isVpnFakeIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

function fakeIpAllowedForHost(host: string) {
  if (isIP(host)) return false;
  return new Set((process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS ?? "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean)).has(host.toLowerCase());
}

function isAllowedModelAddress(host: string, address: string) {
  return isPublicIPv4(address) || (fakeIpAllowedForHost(host) && isVpnFakeIPv4(address));
}

export function modelBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "请填写有效的 API Base URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new ApiError(400, "API 地址须为不含账号、查询参数的公网 HTTPS 地址，使用标准 443 端口。");
  return url.toString().replace(/\/+$/, "");
}

export async function modelAddress(baseUrl: string) {
  const host = new URL(modelBaseUrl(baseUrl)).hostname;
  const addresses = isIP(host) ? [{ address: host }] : await Promise.race([
    lookup(host, { family: 4, all: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new ApiError(400, "API 域名解析超时。")), 10000); timer.unref(); }),
  ]).catch(() => { throw new ApiError(400, "API 域名无法解析到可用的公网地址。"); });
  const allPublic = addresses.length > 0 && addresses.every(row => isPublicIPv4(row.address));
  const allVpnFake = addresses.length > 0 && fakeIpAllowedForHost(host) && addresses.every(row => isVpnFakeIPv4(row.address));
  if (!allPublic && !allVpnFake) throw new ApiError(400, "不允许使用本机、内网或保留地址作为模型 API。");
  return addresses[0].address;
}

export function modelTransport(baseUrl: string, timeout: number, pinnedAddress?: string) {
  const hostname = new URL(baseUrl).hostname;
  return new Agent({
    connect: {
      timeout,
      ...(pinnedAddress ? { lookup: (host, options, callback) => {
        if (host !== hostname || !isAllowedModelAddress(hostname, pinnedAddress)) return callback(new Error("API destination is not allowed"), "", 4);
        if (options.all) callback(null, [{ address: pinnedAddress, family: 4 }]);
        else callback(null, pinnedAddress, 4);
      } } : {}),
    },
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
}

export function modelFetch(transport: Agent, baseUrl: string, options: { preserveStreamingResponse?: boolean; deferResponseBody?: boolean } = {}): typeof globalThis.fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(value).origin !== origin) throw new ApiError(502, "模型请求超出了配置的服务范围。");
    const headers = new Headers(init?.headers ?? (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined));
    headers.set("Accept-Encoding", "identity");
    const streaming = options.preserveStreamingResponse && await modelRequestIsStreaming(input, init);
    const fetchOptions = { ...init, headers, dispatcher: transport, redirect: "error" as const };
    const response = await (httpFetch as unknown as typeof globalThis.fetch)(input, fetchOptions);
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      await response.body?.cancel();
      throw new ApiError(502, "模型接口未遵守响应编码要求，请检查网关配置。");
    }
    // The model-response wrapper can own bounded body reads and measure the
    // interval between receiving headers and the complete response.
    if (streaming || options.deferResponseBody) return response;
    const parts: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 8 * 1024 * 1024) throw new ApiError(502, "模型响应超过 8 MiB 限制，本轮已停止。");
          parts.push(item.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    return new Response(reader ? new Uint8Array(Buffer.concat(parts)) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
