import os
import httpx

from config import backend_url, required


class BackendSearchError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


async def backend(package_id: str, operation: str, data=None) -> dict | list:
    if not package_id.replace("-", "").replace("_", "").isalnum():
        raise ValueError("研究包 ID 格式无效。")
    timeout = 30
    if operation == "rag_file_context":
        timeout = 600
    if operation == "search":
        try:
            timeout = min(120, max(1, int(os.getenv("SEARCH_TIMEOUT_MS", "30000")) / 1000)) + 10
        except ValueError:
            pass  # The Provider factory returns the configuration error.
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        try:
            response = await client.post(
                f"{backend_url()}/api/internal/research/{package_id}",
                headers={"Authorization": f"Bearer {required('SCENARIOFORGE_INTERNAL_TOKEN')}"},
                json={"operation": operation, "data": data},
            )
        except httpx.RequestError as exc:
            if operation in ("begin_search", "search"):
                raise BackendSearchError("upstream_error", "搜索不可用：无法连接 ScenarioForge 后端或请求超时，请确认 Next.js 已启动。") from None
            raise ValueError("无法连接 ScenarioForge 后端，请确认 Next.js 已启动。") from exc
        if response.is_error:
            payload = {}
            try:
                payload = response.json()
                message = payload.get("error", "内部服务调用失败。")
            except ValueError:
                message = "内部服务调用失败。"
            if operation in ("begin_search", "search"):
                raise BackendSearchError(payload.get("code", "upstream_error") if isinstance(payload, dict) else "upstream_error", message) from None
            raise ValueError(message)
        return response.json()
