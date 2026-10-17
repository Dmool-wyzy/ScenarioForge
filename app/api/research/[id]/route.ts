import { getContext } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { readFilePlan } from "@/lib/file-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await getContext((await context.params).id);
    // Conversation history and uploaded private text stay on the server.
    return Response.json({ id: p.id, title: p.title, goal: p.goal, status: p.status, currentStage: p.currentStage, summary: p.summary, filePlan: readFilePlan(p.researchPlan), files: p.files.map(({ filename, content, version, updatedBy, changeNote, lockedBy, updatedAt }) => ({ filename, content, version, updatedBy, changeNote, lockedBy, updatedAt })), events: p.events, evidence: p.evidence, clarifications: p.clarifications }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
