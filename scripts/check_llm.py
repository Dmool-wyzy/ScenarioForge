"""Exercise Python OpenAI SDK request/response handling without external API calls."""
import json
import os
import sys
import unittest
import tempfile
from uuid import uuid4
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))
os.environ["SCENARIOFORGE_ENV_FILE"] = ""

import httpx
from openai import AsyncOpenAI as RealOpenAI
from pydantic import BaseModel, ConfigDict
from llm import structured, ModelFailure, ModelUsageBudget, MODEL_OUTPUT_TOKEN_LIMITS, MAX_OUTPUT_TOKENS_PER_CALL, model_usage_budget
from schemas import GeneratedFile


class Result(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: int


class AdapterChecks(unittest.IsolatedAsyncioTestCase):
    def document_response(self, mode, text, finish, tokens):
        if mode == "chat_completions":
            return httpx.Response(200, json={"id": "fixture", "object": "chat.completion", "created": 0, "model": "fixture",
                "usage": {"prompt_tokens": 20, "completion_tokens": tokens, "total_tokens": 20 + tokens},
                "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": None,
                    "tool_calls": [{"id": "call_fixture", "type": "function", "function": {"name": "GeneratedFile", "arguments": text}}]}}]})
        return httpx.Response(200, json={"id": "resp_fixture", "object": "response", "created_at": 0, "model": "fixture",
            "status": "incomplete" if finish in ("length", "content_filter") else "completed",
            "incomplete_details": {"reason": "max_output_tokens" if finish == "length" else "content_filter"} if finish in ("length", "content_filter") else None,
            "usage": {"input_tokens": 20, "output_tokens": tokens, "total_tokens": 20 + tokens},
            "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}]})

    async def test_document_truncation_retries_with_compact_prompt_in_both_modes(self):
        for mode in ("responses", "chat_completions"):
            for signal in ("explicit", "usage_only", "valid_but_incomplete"):
                with self.subTest(mode=mode, signal=signal):
                    requests = []
                    budget = ModelUsageBudget()
                    def handler(request):
                        body = json.loads(request.content)
                        requests.append(body)
                        cap = body["max_tokens" if mode == "chat_completions" else "max_output_tokens"]
                        self.assertEqual(cap, 8192)
                        if len(requests) == 1:
                            content = '{"filename":"RESEARCH.md","content":"private-draft' if signal != "valid_but_incomplete" else '{"filename":"RESEARCH.md","content":"private-draft"}'
                            return self.document_response(mode, content, "tool_calls" if signal == "usage_only" else "length", cap)
                        self.assertEqual(len(requests), 2)
                        prompt = body["messages"][1]["content"] if mode == "chat_completions" else body["input"]
                        instructions = body["messages"][0]["content"] if mode == "chat_completions" else body["instructions"]
                        self.assertIn("更精简", prompt)
                        self.assertIn("不要续写", prompt)
                        self.assertIn("8192 token", instructions)
                        self.assertIn("字数上限", instructions)
                        self.assertNotIn("private-draft", prompt)
                        return self.document_response(mode, '{"filename":"RESEARCH.md","content":"# 简要研究 [E001]"}', "tool_calls", 30)
                    def client(**kwargs):
                        return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                    with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-key", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture"}), patch("llm.AsyncOpenAI", client), patch("llm.model_usage_budget", return_value=budget), self.assertLogs("scenarioforge", level="WARNING") as logs:
                        result = await structured("fixture", "fixture", GeneratedFile)
                    self.assertEqual(result.filename, "RESEARCH.md")
                    self.assertEqual(len(requests), 2)
                    self.assertEqual(budget.output_tokens, 8192 + 30)
                    self.assertEqual(budget.reserved_output_tokens, 0)
                    self.assertNotIn("private-draft", "\n".join(logs.output))

    async def test_repeated_truncation_stops_and_respects_remaining_run_budget(self):
        for mode in ("responses", "chat_completions"):
            with self.subTest(mode=mode):
                limits = []
                budget = ModelUsageBudget(max_output_tokens=12000)
                def handler(request):
                    body = json.loads(request.content)
                    cap = body["max_tokens" if mode == "chat_completions" else "max_output_tokens"]
                    limits.append(cap)
                    return self.document_response(mode, '{"filename":"RESEARCH.md","content":"private-draft', "length", cap)
                def client(**kwargs):
                    return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-key", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture"}), patch("llm.AsyncOpenAI", client), patch("llm.model_usage_budget", return_value=budget):
                    with self.assertRaises(ModelFailure) as caught:
                        await structured("fixture", "fixture", GeneratedFile)
                self.assertEqual(caught.exception.code, "model_output_truncated")
                self.assertNotIn("private-draft", str(caught.exception))
                self.assertEqual(limits, [8192, 3808])
                self.assertEqual(budget.output_tokens, 12000)
                self.assertEqual(budget.reserved_output_tokens, 0)

    async def test_invalid_format_is_not_reported_as_truncation(self):
        for mode in ("responses", "chat_completions"):
            with self.subTest(mode=mode):
                requests = []
                def handler(request):
                    requests.append(request)
                    return self.document_response(mode, '{"unexpected":"private-draft"}', "tool_calls", 30)
                def client(**kwargs):
                    return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-key", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture"}), patch("llm.AsyncOpenAI", client):
                    with self.assertRaises(ModelFailure) as caught:
                        await structured("fixture", "fixture", GeneratedFile)
                self.assertEqual(caught.exception.code, "invalid_model_output")
                self.assertEqual(len(requests), 2)

    async def test_valid_output_at_cap_is_accepted_without_length_finish_reason(self):
        for mode in ("responses", "chat_completions"):
            with self.subTest(mode=mode):
                requests = []
                def handler(request):
                    requests.append(request)
                    return self.document_response(mode, '{"filename":"RESEARCH.md","content":"# 研究"}', "tool_calls", 8192)
                def client(**kwargs):
                    return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-key", "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture"}), patch("llm.AsyncOpenAI", client):
                    self.assertEqual((await structured("fixture", "fixture", GeneratedFile)).content, "# 研究")
                self.assertEqual(len(requests), 1)

    async def test_other_incomplete_responses_are_not_saved_or_retried(self):
        requests = []
        def handler(request):
            requests.append(request)
            return self.document_response("responses", '{"filename":"RESEARCH.md","content":"# 研究"}', "content_filter", 30)
        def client(**kwargs):
            return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-key", "OPENAI_API_MODE": "responses", "SCENARIOFORGE_MODEL": "fixture"}), patch("llm.AsyncOpenAI", client):
            with self.assertRaises(ModelFailure) as caught:
                await structured("fixture", "fixture", GeneratedFile)
        self.assertEqual(caught.exception.code, "model_incomplete")
        self.assertEqual(len(requests), 1)

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
                self.assertEqual(json.loads(request.content)["max_output_tokens"], MAX_OUTPUT_TOKENS_PER_CALL)
                return httpx.Response(200, json={"id": "resp_fixture", "object": "response", "created_at": 0, "status": "completed", "model": "project-model", "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": '{"value":42}', "annotations": []}]}]})
            def client(**kwargs):
                return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
            with patch.dict(os.environ, {"SCENARIOFORGE_ENV_FILE": str(file), "OPENAI_API_KEY": "system-only-key", "OPENAI_BASE_URL": "http://system.local/v1"}), patch("llm.AsyncOpenAI", client):
                self.assertEqual((await structured("fixture", "fixture", Result)).value, 42)
            file.write_text("OPENAI_API_KEY=\n", encoding="utf-8")
            with patch.dict(os.environ, {"SCENARIOFORGE_ENV_FILE": str(file), "OPENAI_API_KEY": "system-only-key"}):
                with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
                    await structured("fixture", "fixture", Result)

    async def check_mode(self, mode, base_url="http://fixture.local/v1"):
        requests = []

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            if mode == "chat_completions" and httpx.URL(base_url).host == "api.deepseek.com":
                self.assertEqual(body["thinking"], {"type": "disabled"})
            else:
                self.assertNotIn("thinking", body)
            text = "invalid-json" if len(requests) == 1 else '{"value":42}'
            if mode == "chat_completions":
                self.assertTrue(request.url.path.endswith("/chat/completions"))
                self.assertEqual(body["tool_choice"]["function"]["name"], "Result")
                self.assertEqual(body["max_tokens"], 4096)
                return httpx.Response(200, json={"id": "fixture", "object": "chat.completion", "created": 0, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call_fixture", "type": "function", "function": {"name": "Result", "arguments": text}}]}}]})
            self.assertTrue(request.url.path.endswith("/responses"))
            self.assertEqual(body["max_output_tokens"], 4096)
            self.assertEqual(body["text"]["format"]["type"], "json_schema")
            return httpx.Response(200, json={"id": "resp_fixture", "object": "response", "created_at": 0, "status": "completed", "model": "fixture", "output": [{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}]})

        def client(**kwargs):
            return RealOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

        with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-local-key", "OPENAI_BASE_URL": base_url, "OPENAI_API_MODE": mode, "SCENARIOFORGE_MODEL": "fixture-model"}), patch("llm.AsyncOpenAI", client):
            output = await structured("测试结构化适配", "fixture", Result)
        self.assertEqual(output.value, 42)
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(request["model"] == "fixture-model" for request in requests))

    async def test_responses_and_json_retry(self):
        await self.check_mode("responses")

    async def test_chat_tool_call_and_json_retry(self):
        await self.check_mode("chat_completions")

    async def test_deepseek_thinking_disabled_only_for_chat_on_exact_host(self):
        for mode in ("responses", "chat_completions"):
            for base_url in ("https://api.deepseek.com/v1", "https://api.deepseek.com.evil/v1", "https://api.openai.com/v1"):
                with self.subTest(mode=mode, base_url=base_url):
                    await self.check_mode(mode, base_url)

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


class BudgetChecks(unittest.TestCase):
    def test_run_budget_is_shared_by_lease_id(self):
        run_id = f"lease-test-{uuid4().hex}"
        current = model_usage_budget("package-a", run_id)
        repeated = model_usage_budget("package-a", run_id)
        retried = model_usage_budget("package-a", f"{run_id}-retry")
        self.assertIs(current, repeated)
        self.assertIsNot(current, retried)
        current.reserve(1)
        self.assertEqual(repeated.calls, 1)
        self.assertEqual(retried.calls, 0)

    def test_budget_reserves_output_and_stops_at_call_or_token_limit(self):
        budget = ModelUsageBudget(max_calls=2, max_output_tokens=100)
        reserved = budget.reserve(80)
        self.assertEqual(reserved, 80)
        budget.settle(reserved, 12, 20)
        self.assertEqual(budget.output_tokens, 20)
        reserved = budget.reserve(80)
        self.assertEqual(reserved, 80)
        budget.settle(reserved, 9, None)
        self.assertEqual(budget.output_tokens, 100)
        with self.assertRaisesRegex(ModelFailure, "模型调用已达到上限"):
            budget.reserve(1)

    def test_budget_reduces_request_cap_to_remaining_output_tokens(self):
        budget = ModelUsageBudget(max_calls=3, max_output_tokens=30)
        first = budget.reserve(20)
        budget.settle(first, 1, 20)
        second = budget.reserve(20)
        self.assertEqual(second, 10)
        budget.settle(second, 1, 10)
        with self.assertRaisesRegex(ModelFailure, "输出 token 预算已用完"):
            budget.reserve(1)

    def test_output_limits_are_narrower_for_search_and_evidence(self):
        self.assertEqual(MODEL_OUTPUT_TOKEN_LIMITS["SearchQueries"], 512)
        self.assertEqual(MODEL_OUTPUT_TOKEN_LIMITS["EvidenceResult"], 2048)


if __name__ == "__main__":
    unittest.main(verbosity=2)
