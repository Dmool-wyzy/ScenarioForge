import json
from backend import backend, BackendSearchError
from llm import structured, ModelFailure
from schemas import ResearchPlan, RagResearchPlan, SearchQueries, EvidenceResult, REQUIRED_FILENAMES


async def create_research_package(goal: str = "", constraints: dict | None = None, uploaded_files: list[dict] | None = None, package_id: str | None = None) -> dict:
    """Create a research plan. Reuse the current package_id supplied by the backend Agent; omit it only for standalone use."""
    if package_id is None:
        if not goal.strip():
            raise ValueError("独立创建研究包时必须提供 goal；已有研究包只需传入 package_id。")
        package = await backend("new", "create", {"goal": goal, "constraints": constraints or {}, "files": uploaded_files or []})
        package_id = package["id"]
        return {"packageId": package_id, "status": "queued", "researchQuestions": [], "missingInformation": [], "instruction": "研究已排队。使用 get_research_package 查询进度和待澄清问题。"}
    context = await backend(package_id, "context")
    if context.get("researchPlan"):
        plan = context["researchPlan"]
        # Older packages used a fixed output list. Publish a proper plan before their next write.
        if context.get("planNeedsUpgrade") or "filePlan" not in plan:
            names = list(dict.fromkeys([*REQUIRED_FILENAMES, *(file["filename"] for file in context["files"])]))
            plan = {key: plan[key] for key in ("scenarioType", "researchQuestions", "searchQueries", "unknowns")}
            plan["filePlan"] = [{"filename": name, "purpose": {"README.md": "项目概览与工作区导航", "RESEARCH.md": "研究问题、证据及信息缺口", "SOURCES.md": "来源索引与访问记录"}.get(name, "保留已有文档的独立职责与用户资料"), "priority": "required" if name in REQUIRED_FILENAMES else "recommended", "contentOutline": ["保留并核对已有内容", "结合研究证据完善该文件职责范围内的信息"]} for name in names]
            await backend(package_id, "plan", plan)
    else:
        uploaded = context["uploadedFiles"]
        if context.get("ragEnabled"):
            uploaded = [{"filename": row["filename"], "extractedText": row["extractedText"][:2000], "truncated": len(row["extractedText"]) > 2000} for row in uploaded]
        try:
            plan = (await structured(
                """你是研究规划专家。使用中文，按目标复杂度拆成 1–6 个具体研究问题，不凑数量；用户明确提出数量要求时，在该范围内遵守。规划先检索再创作，不编造事实。
生成正文前输出 filePlan，每个文件必须有 filename、purpose、priority(required/recommended/optional)、contentOutline(内容要点列表)。
始终包含 README.md(项目概览与导航)、RESEARCH.md(研究问题、证据、冲突与缺口)、SOURCES.md(来源索引、摘要和访问时间)，三者 priority=required。
根据场景动态选择其他文件，例如 DECISIONS.md、PLAN.md、TODO.md、RISKS.md、DATA_MODEL.md、API_DESIGN.md、EXPERIMENT_PLAN.md、BUDGET.md、TIMELINE.md，也可以规划其他有意义的 Markdown 文件。
示例不是必选清单；简单目标只需三份默认文档。不要凑数量，不要把相同内容拆成多个文件；每份只负责一个明确主题，其余文件通过链接引用。
required 表示必须，recommended 表示场景建议，optional 表示补充；只列入确实准备生成且有具体用途的文件。研究过程中发现新重要主题，可以先追加文件计划再生成。
文件名使用英文字母、数字、下划线或连字符，以 .md 结尾，不带目录。""",
                json.dumps({"goal": context["goal"], "constraints": context["constraints"], "uploadedFiles": uploaded}, ensure_ascii=False),
                RagResearchPlan if context.get("ragEnabled") else ResearchPlan, package_id=package_id,
            )).model_dump()
        except ModelFailure as error:
            return {"status": "planning_failed", "code": error.code, "message": str(error)}
        plan = await backend(package_id, "plan", plan)
    return {"packageId": package_id, "status": "researching", **plan}


async def search_scenario(package_id: str, question: str = "", max_results: int | None = None, question_index: int | None = None, question_id: str | None = None) -> dict:
    """Search the saved research question at question_index (zero-based). Reuse completed evidence without model calls. Legacy question text must exactly match the plan. Maximum 12 new searches per package."""
    if question_index is None and question_id is None and (not question.strip() or len(question) > 1000):
        raise ValueError("研究问题不能为空且最多 1000 字。")
    question = question.strip()
    try:
        selection = {"question_id": question_id} if question_id is not None else {"question_index": question_index} if question_index is not None else question
        settings = await backend(package_id, "begin_search", selection)
    except BackendSearchError as exc:
        return {"status": "search_unavailable", "code": exc.code, "message": str(exc), "instruction": "请告知用户搜索不可用，停止依赖外部事实的生成，不要编造来源。"}
    if settings.get("status") in ("already_researched", "question_required"):
        return settings
    question = settings.get("question", question)
    limit = min(max(1, max_results), settings["maxResults"]) if max_results is not None else settings["maxResults"]
    queries = await structured(
        "为研究问题生成 2–3 个简短、互补的联网搜索查询。每条只保留核心实体名称和一个检索目的，通常 3–8 个关键词；"
        "不要把研究问题的所有字段、同义词或多个数据集名称堆进同一条查询。第一条查核心实体的官方来源，"
        "后续查询按当前问题补充必要细节，优先官方来源，选择合适语言。"
        "只使用当前研究问题涉及的实体，不引入无关项目或数据集名称。",
        question, SearchQueries, package_id=package_id,
    )
    results = []
    seen = set()
    last_error = None
    for query in dict.fromkeys(value.strip() for value in queries.queries if value.strip()):
        try:
            result = await backend(package_id, "search", {"question": question, "query": query, "maxResults": limit})
        except BackendSearchError as exc:
            if exc.code in ("upstream_error", "empty_results"):
                last_error = exc
                continue
            return {"status": "search_unavailable", "code": exc.code, "message": str(exc), "instruction": "请告知用户搜索不可用，停止依赖外部事实的生成，不要编造来源。"}
        for item in result["results"]:
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            results.append({**item, "accessedAt": result["fetchedAt"]})
        if len(results) >= limit:
            break
    results = results[:limit]
    if not results:
        if last_error is not None:
            return {"status": "search_unavailable", "code": last_error.code, "message": str(last_error), "instruction": "所有备选查询均失败。请告知用户搜索不可用，停止本轮，不要重复调用模型或编造来源。"}
        return {"evidence": [], "gap": "未找到可靠来源，该问题结论必须标记为待确认。"}
    drafts = await structured(
        "用中文根据搜索摘要生成证据卡。仅引用给出的来源索引（从 0 开始），禁止生成 URL。只将摘要直接支持的结论标记 verified；建议为 inference，不确定为 unconfirmed。来源数量不代表真实性，谨慎使用 high 置信度。含 [MOCK SEARCH RESULT] 标记的资料仅用于测试，必须标记 unconfirmed、low，并在结论注明测试数据，不能当作真实事实。",
        json.dumps({"question": question, "sources": results}, ensure_ascii=False), EvidenceResult, package_id=package_id,
    )
    if not drafts.cards:
        provider = result["provider"]
        message = ("当前使用 mock 测试搜索，仅有示例来源，模型未提取到有效证据。请切换真实搜索 Provider 后继续研究。"
                   if provider == "mock" else "搜索返回了来源，但模型未提取到有效证据。请调整研究问题或核对来源后继续研究。")
        return {"status": "search_unavailable", "provider": provider, "code": "no_evidence", "message": message,
                "instruction": "请告知用户具体原因并停止本轮，不要重复调用、编造证据或把该问题标记为已完成。"}
    cards = []
    for draft in drafts.cards:
        if any(index < 0 or index >= len(results) for index in draft.source_indices):
            raise ValueError("模型引用了不存在的来源索引，请重试。")
        cards.append({"question": question, "claim": draft.claim, "sources": [results[i] for i in dict.fromkeys(draft.source_indices)], "confidence": draft.confidence, "impact": draft.impact, "status": draft.status})
    return {"evidence": await backend(package_id, "search_evidence", {"question": question, "cards": cards})}
