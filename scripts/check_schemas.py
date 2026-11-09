"""Research plan boundaries; no external API or application database."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))

from pydantic import ValidationError
from schemas import ResearchPlan, RagResearchPlan


def fixture(count, schema):
    questions = [f"Question {index + 1}" for index in range(count)]
    return {
        "scenarioType": "schema_fixture",
        "researchQuestions": [{"question": question, "searchQueries": ["fixture query"], "priority": "high"}
                              for question in questions] if schema is RagResearchPlan else questions,
        "searchQueries": ["fixture query"],
        "unknowns": [],
        **({"missingInformation": []} if schema is RagResearchPlan else {}),
        "filePlan": [{"filename": filename, "purpose": "Fixture document", "priority": "required",
                      "contentOutline": ["Fixture content"]}
                     for filename in ("README.md", "RESEARCH.md", "SOURCES.md")],
    }


class ResearchPlanChecks(unittest.TestCase):
    def test_one_two_and_six_questions_are_valid_for_both_plans(self):
        for schema in (ResearchPlan, RagResearchPlan):
            for count in (1, 2, 6):
                with self.subTest(schema=schema.__name__, count=count):
                    plan = schema.model_validate(fixture(count, schema))
                    self.assertEqual(len(plan.researchQuestions), count)
                    self.assertEqual(len(plan.filePlan), 3)

    def test_empty_and_over_budget_question_lists_are_rejected(self):
        for schema in (ResearchPlan, RagResearchPlan):
            for count in (0, 7):
                with self.subTest(schema=schema.__name__, count=count):
                    with self.assertRaises(ValidationError):
                        schema.model_validate(fixture(count, schema))

    def test_one_question_still_requires_all_three_default_markdown_files(self):
        for schema in (ResearchPlan, RagResearchPlan):
            for defect in ("missing", "renamed", "optional"):
                with self.subTest(schema=schema.__name__, defect=defect):
                    data = fixture(1, schema)
                    if defect == "missing":
                        data["filePlan"].pop()
                    elif defect == "renamed":
                        data["filePlan"][-1]["filename"] = "NOTES.md"
                    else:
                        data["filePlan"][-1]["priority"] = "optional"
                    with self.assertRaises(ValidationError):
                        schema.model_validate(data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
