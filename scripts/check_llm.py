"""Exercise Python OpenAI SDK request/response handling without external API calls."""
import json
import os
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))
os.environ["SCENARIOFORGE_ENV_FILE"] = ""

import httpx
from openai import AsyncOpenAI as RealOpenAI
from pydantic import BaseModel, ConfigDict
from llm import structured, ModelFailure


class Result(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: int


class AdapterChecks(unittest.IsolatedAsyncioTestCase):
    async def test_project_credentials_override_system_in_actual_model_request(self):
        temp_root = Path(__file__).resolve().parent.parent / ".tmp"
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temp_root) as directory:
            file = Path(directory) / ".env.local"
            file.write_text("OPENAI_API_KEY=project-only-key\nOPENAI_BASE_URL=http://project.local/v1\nOPENAI_API_MODE=responses\nSCENARIOFORGE_MODEL=project-model\n", encoding="utf-8")
            def handler(request):
                self.assertEqual(request.headers["authorization"], "Bearer project-only-key")
                self.assertEqual(request.url.host, "project.local")
                self.assertEqual(json.loads(request.content)["model"], "project-model")
                return httpx.Response(200, json={"id": "resp_fixture", "object": "response", "created_at": 0, "status": "completed", "model": "project-model", "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": '{"value":42}', "annotations": []}]}]})
            def client(**kwargs):
                return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
            with patch.dict(os.environ, {"SCENARIOFORGE_ENV_FILE": str(file), "OPENAI_API_KEY": "system-only-key", "OPENAI_BASE_URL": "http://system.local/v1"}), patch("llm.AsyncOpenAI", client):
                self.assertEqual((await structured("fixture", "fixture", Result)).value, 42)
            file.write_text("OPENAI_API_KEY=\n", encoding="utf-8")
            with patch.dict(os.environ, {"SCENARIOFORGE_ENV_FILE": str(file), "OPENAI_API_KEY": "system-only-key"}):
                with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
                    await structured("fixture", "fixture", Result)

    async def check_mode(self, mode):
        requests = []

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            text = "invalid-json" if len(requests) == 1 else '{"value":42}'
            if mode == "chat_completions":
                self.assertTrue(request.url.path.endswith("/chat/completions"))
                self.assertEqual(body["tool_choice"]["function"]["name"], "Result")
                return httpx.Response(200, json={"id": "fixture", "object": "chat.completion", "created": 0, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call_fixture", "type": "function", "function": {"name": "Result", "arguments": text}}]}}]})
            self.assertTrue(request.url.path.endswith("/responses"))
            self.assertEqual(body["text"]["format"]["type"], "json_schema")
            return httpx.Response(200, json={"id": "resp_fixture", "object": "response", "created_at": 0, "status": "completed", "model": "fixture", "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}]})

        def client(**kwargs):
            return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

        with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-local-key", "OPENAI_BASE_URL": "http://fixture.local/v1", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture-model"}), patch("llm.AsyncOpenAI", client):
            output = await structured("测试结构化适配", "fixture", Result)
        self.assertEqual(output.value, 42)
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(request["model"] == "fixture-model" for request in requests))

    async def test_responses_and_json_retry(self):
        await self.check_mode("responses")

    async def test_chat_tool_call_and_json_retry(self):
        await self.check_mode("chat_completions")

    async def test_timeouts_and_rate_limits_do_not_retry_or_expose_provider_content(self):
        for mode in ("responses", "chat_completions"):
            for failure in ("timeout", "rate_limit"):
                with self.subTest(mode=mode, failure=failure):
                    calls = []
                    def handler(request):
                        calls.append(request)
                        if failure == "timeout":
                            raise httpx.ReadTimeout("private provider diagnostic", request=request)
                        return httpx.Response(429, json={"error": {"message": "private provider diagnostic"}})
                    def client(**kwargs):
                        self.assertEqual(kwargs["max_retries"], 0)
                        return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                    with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-local-key", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture", "MODEL_TIMEOUT_SECONDS": "120"}), patch("llm.AsyncOpenAI", client):
                        with self.assertRaises(ModelFailure) as caught:
                            await structured("fixture", "fixture", Result)
                    self.assertEqual(caught.exception.code, "model_timeout" if failure == "timeout" else "model_rate_limited")
                    self.assertNotIn("private provider", str(caught.exception))
                    self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
