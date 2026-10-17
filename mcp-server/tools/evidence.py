from backend import backend
from schemas import validate_filename


async def get_research_package(package_id: str) -> dict:
    """Read research status, structured questions, evidence counts, planned/files metadata and pending clarifications. Does not expose all document bodies or vectors."""
    context = await backend(package_id, "context")
    plan = context.get("researchPlan") or {}
    return {"packageId": package_id, "status": context["status"], "researchQuestions": plan.get("questionDetails", plan.get("researchQuestions", [])),
            "missingInformation": plan.get("missingInformation", []), "filePlan": plan.get("filePlan", []),
            "evidenceCount": len(context.get("evidence", [])), "knowledge": await backend(package_id, "rag_status"),
            "files": [{key: row.get(key) for key in ("filename", "version", "updatedBy", "lockedBy")} for row in context.get("files", [])],
            "clarifications": context.get("clarifications", [])}


async def search_evidence(package_id: str, query: str, top_k: int = 5, source_types: list[str] | None = None) -> dict:
    """Retrieve project-scoped Top-K evidence chunks by cosine similarity. Optional source_types: web/upload/workspace/clarification. Returns explicit insufficient_evidence rather than invented facts."""
    data = {"query": query, "topK": top_k}
    if source_types is not None:
        data["sourceTypes"] = source_types
    return await backend(package_id, "rag_search", data)


async def get_evidence(package_id: str, evidence_id: str) -> dict:
    """Read a full EVIDENCE-n chunk, source URL, timestamp, source revision and citing file versions in this package only."""
    return await backend(package_id, "rag_evidence", evidence_id)


async def get_file_context(package_id: str, filename: str) -> dict:
    """Index pending project material, retrieve bounded evidence for one planned Markdown file and return rag retrieval/version metadata required for saving."""
    validate_filename(filename)
    return await backend(package_id, "rag_file_context", filename)


async def answer_user(package_id: str, clarification_id: str, answer: str | list[str]) -> dict:
    """Submit the user's answer from CLI. Use a question row's id, not its groupId; respects choice validation and resumes paused research."""
    return await backend(package_id, "answer_user", {"clarificationId": clarification_id, "answer": answer})
