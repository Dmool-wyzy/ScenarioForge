"""Exercise the actual FastMCP custom HTTP route; DDGS network calls are mocked."""
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))
import httpx
import search_ddgs
from main import mcp

TOKEN = "ddgs-test-token-" * 3


class DdgsChecks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"SCENARIOFORGE_INTERNAL_TOKEN": TOKEN, "SEARCH_TIMEOUT_MS": "30000"})
        self.env.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=mcp.http_app(path="/mcp")), base_url="http://local.test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.env.stop()

    async def post(self, **kwargs):
        return await self.client.post("/internal/search/ddgs", headers={"Authorization": f"Bearer {TOKEN}"}, json={"query": "Tokyo rental rules", "maxResults": 2}, **kwargs)

    async def test_authentication_and_input_validation(self):
        response = await self.client.post("/internal/search/ddgs", json={"query": "test"})
        self.assertEqual(response.status_code, 401)
        for body in ({"query": " "}, {"query": "test", "maxResults": 0}, {"query": "test", "maxResults": "5"}, {"query": "test", "maxResults": 21}):
            response = await self.client.post("/internal/search/ddgs", headers={"Authorization": f"Bearer {TOKEN}"}, json=body)
            self.assertEqual(response.status_code, 400)

    async def test_actual_ddgs_call_and_normalization(self):
        rows = [{"href": "file:///private"}, {"href": "https://user:secret@example.org/"}, {"title": "Source A", "href": "https://example.org/a", "body": "Excerpt", "raw": "discard"}, {"href": "https://example.org/a"}, {"href": "https://example.org/b"}, {"href": "https://example.org/c"}]
        with patch("search_ddgs.DDGS") as constructor:
            client = constructor.return_value.__enter__.return_value
            client.text.return_value = rows
            response = await self.post()
            constructor.assert_called_once_with(timeout=30)
            client.text.assert_called_once_with(query="Tokyo rental rules", max_results=2, backend="duckduckgo")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["provider"], "ddgs")
        self.assertIn("fetchedAt", result)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["results"][0], {"title": "Source A", "url": "https://example.org/a", "snippet": "Excerpt"})

    async def test_empty_invalid_and_exception_responses(self):
        for rows, code in (([], "empty_results"), ([{"href": "javascript:alert(1)"}], "invalid_response"), ({"results": []}, "invalid_response")):
            with patch("search_ddgs.run_search", return_value=rows):
                response = await self.post()
            self.assertEqual(response.json()["error"]["code"], code)
        for exception, status, code in ((search_ddgs.RatelimitException("private"), 429, "rate_limited"), (search_ddgs.TimeoutException("private"), 504, "upstream_error"), (search_ddgs.DDGSException("No results found."), 502, "empty_results"), (search_ddgs.DDGSException("HTTP 403 private"), 403, "unauthorized"), (search_ddgs.DDGSException("HTTP 429 private"), 429, "rate_limited"), (RuntimeError("private API key"), 502, "upstream_error")):
            with patch("search_ddgs.run_search", side_effect=exception):
                response = await self.post()
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json()["error"]["code"], code)
            self.assertNotIn("private", response.text)

    async def test_missing_dependency_and_timeout(self):
        with patch("search_ddgs.DDGS", None):
            self.assertEqual((await self.post()).json()["error"]["code"], "missing_config")
        async def delayed(*args):
            await asyncio.sleep(0.1)
            return []
        with patch.dict(os.environ, {"SEARCH_TIMEOUT_MS": "1"}), patch("search_ddgs.asyncio.to_thread", delayed):
            self.assertEqual((await self.post()).status_code, 504)


if __name__ == "__main__":
    unittest.main(verbosity=2)
