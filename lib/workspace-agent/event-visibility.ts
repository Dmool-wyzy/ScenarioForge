import "server-only";
import { db } from "../db";

function executionId(event: { payload: unknown }) {
  try {
    const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    return payload && typeof payload === "object" && "executionId" in payload && typeof payload.executionId === "string"
      ? payload.executionId : null;
  } catch { return null; }
}

// Research is shared within a project; local file operations belong to the
// execution's creator. No viewer means a research-model context, not a browser.
export async function visibleResearchEvents<T extends { type: string; payload: unknown }>(packageId: string, events: T[], viewerId?: string): Promise<T[]> {
  const related = events.filter(event => event.type.startsWith("execution_"));
  if (!related.length) return events;
  const ids = [...new Set(related.map(executionId).filter((id): id is string => id !== null))];
  const executions = ids.length ? await db.workspaceExecution.findMany({
    where: { packageId, id: { in: ids }, OR: [{ target: "github" }, ...(viewerId ? [{ target: "local", createdBy: viewerId }] : [])] },
    select: { id: true },
  }) : [];
  const visible = new Set(executions.map(run => run.id));
  return events.filter(event => !event.type.startsWith("execution_") || visible.has(executionId(event) ?? ""));
}
