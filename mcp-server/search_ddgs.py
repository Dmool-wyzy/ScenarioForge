"""Authenticated DDGS bridge. Search orchestration and Provider selection live in Next.js."""
import asyncio
import hmac
import json
import math
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.requests import Request
from starlette.responses import JSONResponse

try:
    from ddgs import DDGS
    from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException
except ImportError:
    DDGS = None
    class DDGSException(Exception):
        pass
    class RatelimitException(Exception):
        pass
    class TimeoutException(Exception):
        pass


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=1000)
    maxResults: int = Field(default=5, ge=1, le=20, strict=True)

    @field_validator("query")
    @classmethod
    def strip_query(cls, value):
        if not value.strip():
            raise ValueError("query 不能为空")
        return value.strip()


def error(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"provider": "ddgs", "code": code, "message": message}}, status_code=status)


def run_search(data: SearchInput, seconds: float):
    with DDGS(timeout=max(1, math.ceil(seconds))) as client:
        return client.text(query=data.query, max_results=data.maxResults, backend="duckduckgo")


def normalize(rows: list, limit: int) -> list[dict]:
    results, seen = [], set()
    for item in rows:
        if not isinstance(item, dict) or not isinstance(item.get("href"), str):
            continue
        try:
            url = urlsplit(item["href"])
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
                continue
            _ = url.port  # reject malformed ports
            value = urlunsplit((url.scheme, url.netloc, url.path, url.query, ""))
        except ValueError:
            continue
        if value.rstrip("/") in seen:
            continue
        seen.add(value.rstrip("/"))
        results.append({"title": str(item.get("title") or value)[:500], "url": value, "snippet": str(item.get("body") or "")[:3000]})
        if len(results) >= limit:
            break
    return results


async def search_ddgs(request: Request) -> JSONResponse:
    expected = os.getenv("SCENARIOFORGE_INTERNAL_TOKEN", "")
    if len(expected) < 32:
        return error("missing_config", "内部凭据尚未配置。", 503)
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(supplied.encode(), f"Bearer {expected}".encode()):
        return error("unauthorized", "内部服务认证失败。", 401)
    try:
        body = await request.body()
        if len(body) > 8192:
            return error("invalid_response", "搜索请求过大。", 413)
        data = SearchInput.model_validate(json.loads(body))
    except (ValueError, ValidationError):
        return error("invalid_response", "搜索请求格式无效：需要 query（1–1000 字）和 maxResults（1–20）。", 400)
    if DDGS is None:
        return error("missing_config", "缺少 ddgs 依赖，请在 mcp-server 目录运行 uv sync --locked 后重启服务。", 503)
    try:
        milliseconds = int(os.getenv("SEARCH_TIMEOUT_MS", "30000"))
        if not 1 <= milliseconds <= 120000:
            raise ValueError()
    except ValueError:
        return error("missing_config", "SEARCH_TIMEOUT_MS 必须为 1–120000 的整数。", 503)
    try:
        rows = await asyncio.wait_for(asyncio.to_thread(run_search, data, milliseconds / 1000), timeout=milliseconds / 1000)
    except RatelimitException:
        return error("rate_limited", "DDGS 已被限流，请稍后重试或切换 Provider。", 429)
    except (TimeoutException, TimeoutError):
        return error("upstream_error", "DDGS 搜索超时，请稍后重试或切换 Provider。", 504)
    except DDGSException as exc:
        detail = str(exc).lower()
        if "no results found" in detail:
            return error("empty_results", "DDGS 未返回搜索结果，请调整查询或切换 Provider。", 502)
        if "ratelimit" in detail or re.search(r"\b429\b", detail):
            return error("rate_limited", "DDGS 已被限流，请稍后重试或切换 Provider。", 429)
        if re.search(r"\b(401|403)\b", detail):
            return error("unauthorized", "DDGS 上游拒绝访问，请稍后重试或切换 Provider。", 403)
        return error("upstream_error", "DDGS 搜索失败，请稍后重试或切换 Provider。", 502)
    except Exception:
        # Never expose DDGS exception bodies: they may include requests or remote HTML.
        return error("upstream_error", "DDGS 搜索失败，请稍后重试或切换 Provider。", 502)
    if not isinstance(rows, list):
        return error("invalid_response", "DDGS 返回的数据格式无效。", 502)
    results = normalize(rows, data.maxResults)
    if not results:
        return error("empty_results" if not rows else "invalid_response", "DDGS 未返回有效搜索结果，请调整查询或切换 Provider。", 502)
    return JSONResponse({"query": data.query, "provider": "ddgs", "results": results, "fetchedAt": datetime.now(timezone.utc).isoformat()})
