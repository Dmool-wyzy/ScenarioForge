"""Project model isolation and pinned HTTPS checks; all HTTP traffic is mocked."""
import ast
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))
os.environ["SCENARIOFORGE_ENV_FILE"] = ""

import httpx
from openai import AsyncOpenAI as RealOpenAI
from pydantic import BaseModel, ConfigDict
from llm import ModelFailure, PinnedModelTransport, structured


class Result(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: int


def settings(name="a", mode="responses"):
    return {"OPENAI_API_KEY": f"fixture-project-key-{name}", "OPENAI_BASE_URL": f"https://model-{name}.example/v1",
            "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": f"model-{name}", "MODEL_TIMEOUT_SECONDS": 120,
            "PROJECT_MODEL_CONFIG": True, "MODEL_VALIDATED_ADDRESS": "93.184.216.34"}


def response(body, value=42):
    if "messages" in body:
        payload = {"id": "fixture", "object": "chat.completion", "created": 0, "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                "tool_calls": [{"id": "call_fixture", "type": "function", "function": {"name": "Result", "arguments": json.dumps({"value": value})}}]}}]}
    else:
        payload = {"id": "fixture", "object": "response", "created_at": 0, "status": "completed", "model": body["model"],
            "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": json.dumps({"value": value}), "annotations": []}]}]}
    return httpx.Response(200, headers={"Content-Type": "application/json"}, stream=httpx.ByteStream(json.dumps(payload).encode()))


class RawStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


class ProjectModelChecks(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_projects_keep_keys_models_and_package_ids_separate(self):
        configurations = {"package-a": settings("a"), "package-b": settings("b", "chat_completions")}
        seen, transports = [], []
        both_started = asyncio.Event()

        async def handler(request):
            body = json.loads(request.content)
            seen.append((request.headers["authorization"], body["model"], request.url.host,
                         request.headers["host"], request.extensions["sni_hostname"]))
            self.assertNotIn("fixture-project-key", request.content.decode())
            if len(seen) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 2)
            return response(body, 1 if body["model"] == "model-a" else 2)

        def transport(**kwargs):
            transports.append(kwargs)
            return httpx.MockTransport(handler)

        backend = AsyncMock(side_effect=lambda package_id, operation: configurations[package_id])
        environment = dict(os.environ)
        with patch("llm.backend", backend), patch("llm.httpx.AsyncHTTPTransport", transport):
            results = await asyncio.gather(*(structured("fixture", "fixture", Result, package_id=name) for name in configurations))
        self.assertEqual([item.value for item in results], [1, 2])
        self.assertEqual(dict(os.environ), environment)
        self.assertEqual(sorted(call.args for call in backend.await_args_list), [("package-a", "model_config"), ("package-b", "model_config")])
        self.assertEqual(sorted(seen), [
            ("Bearer fixture-project-key-a", "model-a", "93.184.216.34", "model-a.example", "model-a.example"),
            ("Bearer fixture-project-key-b", "model-b", "93.184.216.34", "model-b.example", "model-b.example"),
        ])
        self.assertEqual(transports, [{"verify": True, "trust_env": False}] * 2)

    async def test_project_redirects_do_not_follow_or_expose_provider_content(self):
        for mode in ("responses", "chat_completions"):
            seen = []
            def handler(request):
                seen.append(request)
                return httpx.Response(307, headers={"Location": "http://127.0.0.1/private"}, stream=httpx.ByteStream(b'{"error":"fixture-project-key-a"}'))
            with patch("llm.backend", AsyncMock(return_value=settings(mode=mode))), patch("llm.httpx.AsyncHTTPTransport", return_value=httpx.MockTransport(handler)):
                with self.assertLogs("scenarioforge", level="ERROR") as logs, self.assertRaises(ModelFailure) as failure:
                    await structured("fixture", "fixture", Result, package_id="package-a")
            self.assertEqual(len(seen), 1)
            self.assertEqual(failure.exception.code, "model_api_error")
            self.assertNotIn("fixture-project-key", str(failure.exception) + " ".join(logs.output))

    async def test_global_fixture_configuration_uses_backend_values_without_pin(self):
        config = {**settings(), "PROJECT_MODEL_CONFIG": False, "OPENAI_BASE_URL": "http://fixture.local/v1"}
        def handler(request):
            self.assertEqual(request.headers["authorization"], "Bearer fixture-project-key-a")
            self.assertEqual(request.url.host, "fixture.local")
            return response(json.loads(request.content))
        def client(**kwargs):
            self.assertEqual(kwargs["max_retries"], 0)
            self.assertEqual(kwargs["timeout"], 120)
            return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with patch("llm.backend", AsyncMock(return_value=config)), patch("llm.AsyncOpenAI", client):
            self.assertEqual((await structured("fixture", "fixture", Result, package_id="package-a")).value, 42)

    async def test_failed_project_configuration_never_falls_back_to_process_settings(self):
        backend = AsyncMock(side_effect=ValueError("fixture-project-key-a must not escape"))
        with patch("llm.backend", backend), patch("llm.AsyncOpenAI") as client:
            with self.assertRaises(ModelFailure) as failure:
                await structured("fixture", "fixture", Result, package_id="package-a")
        self.assertEqual(failure.exception.code, "missing_config")
        self.assertNotIn("fixture-project-key", str(failure.exception))
        client.assert_not_called()

    async def test_transport_rejects_private_ips_and_changed_destination_before_send(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "240.0.0.1", "::1", "not-an-ip"):
            with self.subTest(address=address), self.assertRaises(ModelFailure):
                PinnedModelTransport("https://model-a.example/v1", address)
        for url in ("http://model-a.example/v1", "https://model-a.example:444/v1", "https://secret@model-a.example/v1"):
            with self.subTest(url=url), self.assertRaises(ModelFailure):
                PinnedModelTransport(url, "93.184.216.34")
        inner = AsyncMock(spec=httpx.AsyncBaseTransport)
        with patch("llm.httpx.AsyncHTTPTransport", return_value=inner):
            transport = PinnedModelTransport("https://model-a.example/v1", "93.184.216.34")
        try:
            for url in ("http://model-a.example/v1/responses", "https://other.example/v1/responses", "https://model-a.example:444/v1/responses"):
                with self.subTest(url=url), self.assertRaises(ModelFailure):
                    await transport.handle_async_request(httpx.Request("POST", url))
            inner.handle_async_request.assert_not_awaited()
        finally:
            await transport.aclose()
        inner.aclose.assert_awaited_once()

    async def test_response_limit_preserves_normal_response_headers_and_closes_raw_stream(self):
        stream = RawStream([b'{"value":', b'42}'])
        def handler(request):
            self.assertEqual(request.headers["Accept-Encoding"], "identity")
            return httpx.Response(202, headers={"Content-Encoding": "identity", "X-Fixture": "preserved"}, stream=stream)
        with patch("llm.httpx.AsyncHTTPTransport", return_value=httpx.MockTransport(handler)):
            transport = PinnedModelTransport("https://model-a.example/v1", "93.184.216.34")
        try:
            result = await transport.handle_async_request(httpx.Request("POST", "https://model-a.example/v1/responses", headers={"Accept-Encoding": "gzip"}))
            self.assertEqual(result.status_code, 202)
            self.assertEqual(result.headers["X-Fixture"], "preserved")
            self.assertEqual(result.json(), {"value": 42})
            self.assertTrue(stream.closed)
        finally:
            await transport.aclose()

    async def test_response_limit_stops_at_first_byte_over_eight_mib_without_trusting_length(self):
        stream = RawStream([b'x' * 65536] * 128 + [b'x', b'must-not-be-read'])
        with patch("llm.httpx.AsyncHTTPTransport", return_value=httpx.MockTransport(
                lambda request: httpx.Response(200, headers={"Content-Length": "1"}, stream=stream))):
            transport = PinnedModelTransport("https://model-a.example/v1", "93.184.216.34")
        try:
            with self.assertRaises(ModelFailure) as failure:
                await transport.handle_async_request(httpx.Request("POST", "https://model-a.example/v1/responses"))
            self.assertEqual(failure.exception.code, "model_unavailable")
            self.assertEqual(stream.reads, 129)
            self.assertTrue(stream.closed)
        finally:
            await transport.aclose()

    async def test_non_identity_encoding_is_rejected_before_reading_any_body(self):
        for encoding in ("gzip", "br", "gzip, identity"):
            stream = RawStream([b'compressed-provider-secret'])
            with patch("llm.httpx.AsyncHTTPTransport", return_value=httpx.MockTransport(
                    lambda request: httpx.Response(200, headers={"Content-Encoding": encoding}, stream=stream))):
                transport = PinnedModelTransport("https://model-a.example/v1", "93.184.216.34")
            try:
                with self.subTest(encoding=encoding), self.assertRaises(ModelFailure) as failure:
                    await transport.handle_async_request(httpx.Request("POST", "https://model-a.example/v1/responses"))
                self.assertEqual(stream.reads, 0)
                self.assertTrue(stream.closed)
                self.assertNotIn("provider-secret", str(failure.exception))
            finally:
                await transport.aclose()

    def test_every_real_tool_model_call_forwards_its_package_id(self):
        root = Path(__file__).resolve().parent.parent / "mcp-server" / "tools"
        calls = 0
        for name in ("research.py", "files.py"):
            for node in ast.walk(ast.parse((root / name).read_text(encoding="utf-8"))):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "structured":
                    keyword = next((item.value for item in node.keywords if item.arg == "package_id"), None)
                    self.assertIsInstance(keyword, ast.Name, f"{name}:{node.lineno} dropped package_id")
                    self.assertEqual(keyword.id, "package_id")
                    calls += 1
        self.assertEqual(calls, 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
