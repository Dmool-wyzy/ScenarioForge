import { requireResearchAccess } from "@/lib/auth";
import { getContext } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { readFilePlan } from "@/lib/file-plan";
import { readDocumentProposal } from "@/lib/plan-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const user = await requireResearchAccess(request, id);
    const p = await getContext(id, undefined, user.id);
    const documentProposal = readDocumentProposal(p.events, p);
    // Raw model session state and uploaded private text stay on the server.
    return Response.json({ id: p.id, title: p.title, goal: p.goal, status: p.status, taskState: p.taskState, currentStage: p.currentStage, summary: p.summary, documentProposal, documentProposalStale: Boolean(documentProposal && documentProposal.contextVersion !== p.contextVersion), filePlan: readFilePlan(p.researchPlan), files: p.files.map(({ filename, content, version, updatedBy, changeNote, lockedBy, updatedAt }) => ({ filename, content, version, updatedBy, changeNote, lockedBy, updatedAt })), events: p.events, evidence: p.evidence, clarifications: p.clarifications }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
