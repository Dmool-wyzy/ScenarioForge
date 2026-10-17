"""File generation and checkpoint recovery without API or database calls."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))
from llm import ModelFailure
from schemas import GeneratedFile
from tools.files import generate_workspace
from tools.source_links import unsupported_links


def fixture():
    names = ["README.md", "RESEARCH.md", "SOURCES.md", "PLAN.md", "TODO.md"]
    return {"goal": "file generation fixture", "constraints": {}, "uploadedFiles": [], "ragEnabled": False,
            "researchPlan": {"researchQuestions": ["question"], "filePlan": [{"filename": name, "purpose": "fixture", "priority": "required" if name in names[:3] else "recommended", "contentOutline": ["fixture"]} for name in names]},
            "searchedQuestions": ["question"], "evidence": [{"code": "E001", "question": "question", "claim": "fixture", "confidence": "low", "status": "unconfirmed", "sources": [{"url": "https://example.org/source", "title": "source", "snippet": "fixture with https://unrelated.example/ incidental URL", "accessedAt": "2026-10-16T00:00:00Z"}]}], "clarifications": [], "files": []}


class GenerationChecks(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_keeps_saved_file_and_resumes_only_missing_files_in_batches(self):
        context = fixture()
        generated, writes = [], []
        fail_second = True
        async def model(system, prompt, schema):
            nonlocal fail_second
            self.assertIs(schema, GeneratedFile)
            data = json.loads(prompt)
            self.assertNotIn("files", data)
            self.assertLess(len(prompt), 24000)
            filename = data["filePlan"]["filename"]
            generated.append(filename)
            if filename == "RESEARCH.md" and fail_second:
                fail_second = False
                raise ModelFailure("model_timeout", "模型服务等待超时，未自动重试。")
            return GeneratedFile(filename=filename, content=f"# {filename}\nFixture [E001]")
        async def backend(package_id, operation, data=None):
            if operation == "context":
                return context
            self.assertEqual(operation, "write_file")
            writes.append(data["filename"])
            context["files"].append({"filename": data["filename"], "content": data["content"], "version": 1, "changeNote": data["reason"], "userModified": False, "lockedBy": None})
            return {"status": "created", "filename": data["filename"], "version": 1}
        with patch("tools.files.backend", backend), patch("tools.files.structured", model):
            first = await generate_workspace("fixture-package")
            self.assertEqual(first["status"], "generation_failed")
            self.assertEqual(first["filename"], "RESEARCH.md")
            self.assertEqual(first["code"], "model_timeout")
            self.assertEqual(writes, ["README.md"])
            second = await generate_workspace("fixture-package")
            self.assertEqual(second["status"], "in_progress")
            self.assertEqual(second["remaining"], ["TODO.md"])
            third = await generate_workspace("fixture-package")
            self.assertEqual(third["status"], "completed")
            fourth = await generate_workspace("fixture-package")
            self.assertEqual(fourth["status"], "completed")
        self.assertEqual(generated, ["README.md", "RESEARCH.md", "RESEARCH.md", "PLAN.md", "TODO.md"])
        self.assertEqual(writes, ["README.md", "RESEARCH.md", "SOURCES.md", "PLAN.md", "TODO.md"])
        self.assertIn("https://example.org/source", context["files"][2]["content"])
        self.assertNotIn("https://unrelated.example/", context["files"][2]["content"])

    async def test_unprovided_links_fail_before_write_after_one_content_correction(self):
        context = fixture()
        backend = AsyncMock(return_value=context)
        model = AsyncMock(return_value=GeneratedFile(filename="README.md", content="[invented](https://unprovided.example/)"))
        with patch("tools.files.backend", backend), patch("tools.files.structured", model):
            result = await generate_workspace("fixture-package")
        self.assertEqual(result["code"], "invalid_model_output")
        self.assertEqual(result["status"], "generation_failed")
        self.assertEqual(model.await_count, 2)
        self.assertEqual(backend.await_count, 1)

    def test_source_links_accept_markdown_parentheses_entities_and_fragments(self):
        sources = {"https://example.org/Topic_(event)", "https://example.org/search?a=1&b=2"}
        self.assertEqual(unsupported_links("[来源](https://example.org/Topic_(event))。", sources), [])
        self.assertEqual(unsupported_links("<https://EXAMPLE.org:443/search?a=1&amp;b=2#section>", sources), [])
        for value in ("https://example.org.evil.test/Topic_(event)", "https://example.org/another", "https://example.org/search?a=1&b=3"):
            self.assertTrue(unsupported_links(value, sources))

    async def test_unknown_link_is_corrected_once_then_saved_without_losing_prior_files(self):
        context = fixture()
        context["files"] = [{"filename": name, "userModified": True, "version": 1, "lockedBy": None} for name in ("README.md", "SOURCES.md", "PLAN.md", "TODO.md")]
        async def backend(package_id, operation, data=None):
            if operation == "context":
                return context
            self.assertEqual(data["filename"], "RESEARCH.md")
            self.assertNotIn("unprovided.example", data["content"])
            return {"status": "created", "filename": data["filename"], "version": 1}
        model = AsyncMock(side_effect=[GeneratedFile(filename="RESEARCH.md", content="[未知](https://unprovided.example/)"),
                                      GeneratedFile(filename="RESEARCH.md", content="# 研究\n\n结论待确认 [E001]，详见 [来源](SOURCES.md)。")])
        with patch("tools.files.backend", backend), patch("tools.files.structured", model):
            result = await generate_workspace("fixture-package")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(model.await_count, 2)
        self.assertEqual([row["status"] for row in result["files"]].count("preserved"), 4)

    async def test_user_files_preserved_and_blocking_questions_or_locks_stop_before_model(self):
        for state in ("waiting", "locked"):
            context = fixture()
            if state == "waiting":
                context["clarifications"] = [{"priority": "blocking", "status": "waiting"}]
            else:
                context["files"] = [{"filename": "README.md", "lockedBy": "user", "userModified": True}]
            backend = AsyncMock(return_value=context)
            model = AsyncMock()
            with patch("tools.files.backend", backend), patch("tools.files.structured", model):
                result = await generate_workspace("fixture-package")
            self.assertEqual(result["status"], "waiting_for_user" if state == "waiting" else "locked")
            model.assert_not_awaited()

    async def test_large_card_sets_are_not_all_sent_to_each_file(self):
        from tools.file_context import file_context
        context = fixture()
        context["evidence"] = [{**context["evidence"][0], "code": f"E{index:03}", "claim": "evidence " * 400} for index in range(1, 101)]
        bounded = file_context(context, context["researchPlan"]["filePlan"][0])
        self.assertLessEqual(len(bounded["evidence"]), 10)
        self.assertLess(len(json.dumps(bounded)), 24000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
