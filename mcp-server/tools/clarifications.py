import asyncio
import time

from backend import backend


async def ask_user(package_id: str, questions: list[dict]) -> dict:
    """Ask at most six questions in two rounds. Each question needs question, type (text/single_choice/multi_choice), options for choices, priority (blocking/optional), why_needed, optional safe default_assumption. Stop the Agent turn on blocking questions."""
    return await backend(package_id, "ask", questions)


async def get_user_answers(package_id: str, clarification_id: str, timeout_seconds: int = 600) -> dict:
    """Poll answers for a clarification group. Blocking questions without safe defaults remain blocked on timeout. Defaults are marked timeout_default. The backend Agent resumes via durable state instead of holding a long request."""
    timeout_seconds = max(0, min(timeout_seconds, 600))
    deadline = time.monotonic() + timeout_seconds
    while True:
        result = await backend(package_id, "answers", {"clarificationId": clarification_id})
        if result["status"] != "waiting_for_user":
            return result
        if time.monotonic() >= deadline:
            return await backend(package_id, "answers", {"clarificationId": clarification_id, "timeout": True})
        await asyncio.sleep(min(2, max(0, deadline - time.monotonic())))
