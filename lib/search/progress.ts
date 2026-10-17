// Old packages recorded only search_started. New searches require successful evidence persistence.
export function completedSearchQuestions(events: { type: string; payload: unknown }[]) {
  const completed = new Set<string>();
  for (const event of events) {
    let payload = event.payload;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { continue; } }
    if (!payload || typeof payload !== "object" || !("question" in payload) || typeof payload.question !== "string") continue;
    const question = payload.question.trim();
    if (event.type === "search_completed") completed.add(question);
    if (event.type === "search_failed") completed.delete(question);
    if (event.type === "search_started") {
      if (!("provider" in payload) && !("query" in payload)) completed.add(question);
      else completed.delete(question);
    }
  }
  return completed;
}
