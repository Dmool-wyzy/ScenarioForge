import "server-only";
import { ApiError } from "./errors";

// Only the local development server can delegate Git operations over its SSH tunnel.
// The production route still authenticates the same session and enforces project roles.
export async function forwardRepositoryRequest(request: Request, projectId: string, action?: unknown, fetcher: typeof fetch = fetch) {
  const target = process.env.SCENARIOFORGE_REPOSITORY_BACKEND_URL;
  if (!target) return null;
  if (process.env.NODE_ENV !== "development" || request.headers.has("x-scenarioforge-repository-relay")) {
    throw new ApiError(503, "仓库连接配置无效，请检查本地开发环境。");
  }
  let backend: URL, origin: URL;
  try {
    backend = new URL(target);
    origin = new URL(process.env.SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN ?? "");
    if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1" || !backend.port || backend.pathname !== "/" || backend.username || backend.password || backend.search || backend.hash) throw new Error();
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) throw new Error();
  } catch { throw new ApiError(503, "仓库连接配置无效，请检查本地开发环境。"); }
  const session = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith("scenarioforge_session="))?.slice("scenarioforge_session=".length);
  if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session)) throw new ApiError(401, "请先登录。");
  const url = new URL(`/api/projects/${projectId}/repository`, backend);
  const task = new URL(request.url).searchParams.get("task");
  if (task !== null) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(task)) throw new ApiError(400, "任务编号无效。");
    url.searchParams.set("task", task);
  }
  for (const key of ["view", "branch", "path", "skip", "commit"]) {
    const value = new URL(request.url).searchParams.get(key);
    if (value !== null) {
      if (value.length > 500 || /[\u0000-\u001f]/.test(value)) throw new ApiError(400, "仓库查询参数无效。");
      url.searchParams.set(key, value);
    }
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: action === undefined ? "GET" : "POST",
      headers: {
        Cookie: `__Host-scenarioforge_session=${session}`,
        Origin: origin.origin,
        "Content-Type": "application/json",
        "x-scenarioforge-repository-relay": "1",
      },
      ...(action === undefined ? {} : { body: JSON.stringify(action) }),
      cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(action && typeof action === "object" && "action" in action && action.action === "import" ? 180000 : 60000)]),
    });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error();
    const body: unknown = await response.json();
    return Response.json(body, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    throw new ApiError(503, "暂时无法连接团队仓库。请检查本地 SSH 连接后重新读取；如刚提交过操作，请先刷新确认结果。");
  }
}
