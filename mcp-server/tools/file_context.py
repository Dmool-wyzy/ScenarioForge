"""Bounded evidence selection for generation without an embeddings service."""
import hashlib
import json
import re


def generation_signature(context: dict, item: dict) -> str:
    data = {key: context[key] for key in ("goal", "constraints", "uploadedFiles", "evidence", "clarifications")}
    data["filePlan"] = item
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def terms(text: str) -> set[str]:
    words = set(re.findall(r"[a-z0-9_-]+", text.lower()))
    for group in re.findall(r"[\u3400-\u9fff]+", text):
        words.update(group[index:index + 2] for index in range(max(1, len(group) - 1)))
    return words


def file_context(context: dict, item: dict) -> dict:
    query = terms(" ".join([item["purpose"], *item["contentOutline"]]))
    ranked = sorted(context["evidence"], key=lambda row: len(query & terms(row["question"])) * 3 + len(query & terms(row["claim"])), reverse=True)
    # First retain coverage across research questions, then fill with the most
    # relevant cards. This is lexical selection, not vector RAG.
    distinct, seen = [], set()
    for row in ranked:
        if row["question"] not in seen:
            distinct.append(row)
            seen.add(row["question"])
    candidates = distinct + [row for row in ranked if row not in distinct]
    cards, budget = [], 13000
    for row in candidates:
        card = {key: row[key] for key in ("code", "question", "claim", "confidence", "status")}
        card["claim"] = card["claim"][:1200]
        card["sources"] = [{"title": source["title"][:200], "url": source["url"], "snippet": source["snippet"][:450], "accessedAt": source["accessedAt"]} for source in row["sources"][:2]]
        length = len(json.dumps(card, ensure_ascii=False))
        if length <= budget:
            cards.append(card)
            budget -= length
        if len(cards) == 10:
            break
    uploaded = []
    remaining = 1800
    for row in context["uploadedFiles"]:
        text = row["extractedText"][:remaining]
        uploaded.append({"filename": row["filename"], "extractedText": text, "truncated": len(text) < len(row["extractedText"])})
        remaining -= len(text)
    return {"goal": context["goal"], "constraints": context["constraints"], "filePlan": item,
            "fileNavigation": [row["filename"] for row in context["researchPlan"]["filePlan"]],
            "uploadedFiles": uploaded, "evidence": cards, "evidenceSelection": "词项匹配及研究问题覆盖；仅供当前文件使用。仅引用本次提供的证据，不补造被截断内容。",
            "clarifications": [{"question": row["question"][:300], "answer": (row.get("answer") or "")[:1200], "status": row["status"], "answeredBy": row.get("answeredBy"), "defaultAssumption": (row.get("defaultAssumption") or "")[:500]} for row in context["clarifications"]]}


def sources_markdown(context: dict) -> str:
    """Source metadata is already verified by the search backend, no LLM needed."""
    sources = {}
    for card in context["evidence"]:
        for source in card["sources"]:
            row = sources.setdefault(source["url"], {**source, "codes": []})
            if card["code"] not in row["codes"]:
                row["codes"].append(card["code"])
    def literal(value):
        # Avoid promoting incidental snippet links into additional cited sources.
        return str(value).replace("http://", "http：//").replace("https://", "https：//").replace("\r", " ").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")
    lines = ["# 来源索引", "", "> 以下为实际搜索返回的来源及摘要；收录不等于已核实全文或已确认许可。", ""]
    for index, source in enumerate(sources.values(), 1):
        lines.extend([f"## {index}. {literal(source['title'])}", "", f"- URL：<{source['url']}>", f"- 访问时间：{literal(source['accessedAt'])}", f"- 证据卡：{', '.join(source['codes'])}", f"- 搜索摘要：{literal(source['snippet'])}", ""])
    content = "\n".join(lines)
    # Respect the backend file limit; never silently omit sources.
    if len(content) > 100000:
        raise ValueError("来源索引超过单文件限制，请拆分文件计划后继续。")
    return content
