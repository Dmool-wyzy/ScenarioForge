"""Offline integration fixture. Never used by the application startup command."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-server"))

import httpx
from main import mcp
from schemas import ResearchPlan, RagResearchPlan, SearchQueries, EvidenceResult, GeneratedWorkspace, GeneratedFile

REAL_CLIENT = httpx.AsyncClient


async def fixture_model(system, context, schema):
    if schema in (ResearchPlan, RagResearchPlan):
        names = ["README.md", "RESEARCH.md", "SOURCES.md", "DECISIONS.md", "PLAN.md"]
        questions = ["测试问题一", "测试问题二", "测试问题三"]
        return schema(scenarioType="integration_fixture", researchQuestions=[{"question": question, "searchQueries": ["fixture"], "priority": "high"} for question in questions] if schema is RagResearchPlan else questions, **({"missingInformation": []} if schema is RagResearchPlan else {}), searchQueries=["fixture"], unknowns=[], filePlan=[{"filename": name, "purpose": f"测试夹具：{name}", "priority": "required" if name in ("README.md", "RESEARCH.md", "SOURCES.md") else "recommended", "contentOutline": ["仅验证流程，不构成研究结论"]} for name in names])
    if schema is SearchQueries:
        return SearchQueries(queries=["fixture"])
    if schema is EvidenceResult:
        return EvidenceResult(cards=[{"claim": "这是测试夹具，不是实际研究事实。", "source_indices": [0], "confidence": "low", "impact": "仅用于验证流程", "status": "unconfirmed"}])
    if schema is GeneratedWorkspace:
        data = json.loads(context)
        source = data["evidence"][0]["sources"][0]["url"]
        previous = {f["filename"]: f for f in data["files"]}
        return GeneratedWorkspace(files=[{"filename": item["filename"], "content": previous[item["filename"]]["content"] if previous.get(item["filename"], {}).get("userModified") else f"# {item['filename']}\n\n[MOCK] 这是自动验证文档，所有结论待确认。\n\n[测试来源]({source})"} for item in data["researchPlan"]["filePlan"]], summary="已按文件计划生成测试文档。")
    if schema is GeneratedFile:
        data = json.loads(context)
        hits = data.get("retrieval", {}).get("results", [])
        citation = f"[{hits[0]['evidenceId']}]" if hits else f"[{data['evidence'][0]['code']}]" if data.get("evidence") else "> ⚠️ 待确认：当前证据不足以判断。"
        return GeneratedFile(filename=data["filePlan"]["filename"], content=f"# {data['filePlan']['filename']}\n\n[MOCK] 仅为流程测试，所有结论待确认。{citation}")
    raise AssertionError(f"Unexpected schema {schema}")


async def transport(request):
    if request.url.host not in ("localhost", "127.0.0.1"):
        raise AssertionError("Fixture attempted to contact an external service")
    async with REAL_CLIENT(trust_env=False) as client:
        return await client.send(request)


def fixture_client(*args, **kwargs):
    kwargs["transport"] = httpx.MockTransport(transport)
    return REAL_CLIENT(*args, **kwargs)


if __name__ == "__main__":
    with patch("tools.research.structured", fixture_model), patch("tools.files.structured", fixture_model), patch("httpx.AsyncClient", fixture_client):
        mcp.run(transport="streamable-http", host="127.0.0.1", port=8001, path="/mcp", show_banner=False)
