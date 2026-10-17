"""Research evidence failure checks; no external API or application database."""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))

from backend import BackendSearchError
from schemas import EvidenceResult, SearchQueries
from tools.research import create_research_package, search_scenario


class CreationChecks(unittest.IsolatedAsyncioTestCase):
    async def test_existing_package_needs_only_its_id_and_reuses_the_saved_plan(self):
        plan = {"filePlan": [], "researchQuestions": ["saved question"]}
        backend = AsyncMock(return_value={"researchPlan": plan})
        model = AsyncMock()
        with patch("tools.research.backend", backend), patch("tools.research.structured", model):
            result = await create_research_package(package_id="owned-package")
        backend.assert_awaited_once_with("owned-package", "context")
        model.assert_not_awaited()
        self.assertEqual(result["researchQuestions"], ["saved question"])

    async def test_standalone_creation_rejects_a_missing_goal_before_any_backend_call(self):
        backend = AsyncMock()
        with patch("tools.research.backend", backend):
            with self.assertRaisesRegex(ValueError, "goal"):
                await create_research_package()
        backend.assert_not_awaited()


class EvidenceChecks(unittest.IsolatedAsyncioTestCase):
    async def test_completed_or_invalid_question_returns_before_any_model_call(self):
        for status in ("already_researched", "question_required"):
            with self.subTest(status=status):
                backend = AsyncMock(return_value={"status": status, "question": "Saved question", "evidence": []})
                model = AsyncMock()
                with patch("tools.research.backend", backend), patch("tools.research.structured", model):
                    result = await search_scenario("fixture-package", question_index=0)
                self.assertEqual(result["status"], status)
                backend.assert_awaited_once_with("fixture-package", "begin_search", {"question_index": 0})
                model.assert_not_awaited()

    async def test_index_uses_the_backend_canonical_question_instead_of_rewritten_text(self):
        operations = []
        async def backend(package_id, operation, data):
            operations.append((operation, data))
            if operation == "begin_search":
                return {"maxResults": 1, "question": "Saved question"}
            if operation == "search":
                raise BackendSearchError("unauthorized", "Unavailable")
            self.fail(f"Unexpected operation: {operation}")
        model = AsyncMock(return_value=SearchQueries(queries=["fixture query"]))
        with patch("tools.research.backend", backend), patch("tools.research.structured", model):
            await search_scenario("fixture-package", question="Rewritten", question_index=0)
        self.assertEqual(operations[0], ("begin_search", {"question_index": 0}))
        self.assertEqual(operations[1][1]["question"], "Saved question")
        self.assertEqual(model.await_args.args[1], "Saved question")

    async def run_queries(self, outcomes):
        searches = []
        persisted = []

        async def backend(package_id, operation, data):
            if operation == "begin_search":
                return {"maxResults": 2}
            if operation == "search":
                searches.append(data["query"])
                outcome = outcomes[len(searches) - 1]
                if isinstance(outcome, Exception):
                    raise outcome
                return {"provider": "ddgs", "fetchedAt": "2026-10-16T00:00:00Z", "results": outcome}
            if operation == "search_evidence":
                persisted.extend(data["cards"])
                return data["cards"]
            self.fail(f"Unexpected operation: {operation}")

        model = AsyncMock(side_effect=[
            SearchQueries(queries=["SHWD dataset github", "SHWD dataset paper", "SHWD dataset license"]),
            EvidenceResult(cards=[{"claim": "Fixture claim", "source_indices": [0], "confidence": "low", "impact": "Fixture", "status": "unconfirmed"}]),
        ])
        with patch("tools.research.backend", backend), patch("tools.research.structured", model):
            result = await search_scenario("fixture-package", "fixture question")
        return result, searches, persisted, model

    async def test_timeout_and_empty_result_try_remaining_queries_without_regenerating_queries(self):
        source = {"title": "Fixture", "url": "https://example.org/source", "snippet": "Fixture source"}
        result, searches, persisted, model = await self.run_queries([
            BackendSearchError("upstream_error", "Timed out"), BackendSearchError("empty_results", "No results"), [source],
        ])
        self.assertEqual(len(searches), 3)
        self.assertEqual(model.await_count, 2)
        self.assertEqual(persisted[0]["sources"][0]["url"], source["url"])
        self.assertIn("evidence", result)

    async def test_a_later_query_failure_preserves_sources_already_found(self):
        source = {"title": "Fixture", "url": "https://example.org/source", "snippet": "Fixture source"}
        result, searches, persisted, model = await self.run_queries([
            [source], BackendSearchError("upstream_error", "Timed out"), BackendSearchError("empty_results", "No results"),
        ])
        self.assertEqual(len(searches), 3)
        self.assertEqual(len(persisted), 1)
        self.assertEqual(model.await_count, 2)
        self.assertIn("evidence", result)

    async def test_all_queries_failing_stops_before_evidence_model_or_persistence(self):
        result, searches, persisted, model = await self.run_queries([BackendSearchError("upstream_error", "Timed out")] * 3)
        self.assertEqual(len(searches), 3)
        self.assertEqual(result["status"], "search_unavailable")
        self.assertEqual(result["code"], "upstream_error")
        self.assertEqual(model.await_count, 1)
        self.assertEqual(persisted, [])

    async def test_configuration_authentication_and_rate_limits_fail_immediately(self):
        for code in ("missing_config", "unauthorized", "rate_limited", "invalid_response"):
            with self.subTest(code=code):
                result, searches, persisted, model = await self.run_queries([BackendSearchError(code, "Unavailable")])
                self.assertEqual(len(searches), 1)
                self.assertEqual(result["code"], code)
                self.assertEqual(model.await_count, 1)
                self.assertEqual(persisted, [])

    async def check_empty_evidence(self, provider):
        operations = []

        async def backend(package_id, operation, data):
            operations.append(operation)
            if operation == "begin_search":
                return {"maxResults": 1}
            if operation == "search":
                return {"provider": provider, "fetchedAt": "2026-10-16T00:00:00Z", "results": [
                    {"title": "Fixture source", "url": "https://example.org/source", "snippet": "Insufficient evidence"}
                ]}
            self.fail("Empty evidence must not be sent to the persistence API")

        model = AsyncMock(side_effect=[SearchQueries(queries=["fixture"]), EvidenceResult(cards=[])])
        with patch("tools.research.backend", backend), patch("tools.research.structured", model):
            result = await search_scenario("fixture-package", "fixture question")
        self.assertEqual(result["status"], "search_unavailable")
        self.assertEqual(result["code"], "no_evidence")
        self.assertEqual(result["provider"], provider)
        self.assertEqual(operations, ["begin_search", "search"])
        self.assertEqual(model.await_count, 2)
        return result

    async def test_mock_empty_evidence_reports_search_configuration(self):
        result = await self.check_empty_evidence("mock")
        self.assertIn("mock", result["message"])
        self.assertIn("真实搜索", result["message"])

    async def test_real_search_empty_evidence_reports_insufficient_sources(self):
        result = await self.check_empty_evidence("ddgs")
        self.assertIn("未提取到有效证据", result["message"])
        self.assertNotIn("mock", result["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
