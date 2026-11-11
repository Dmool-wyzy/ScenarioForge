import { z } from "zod";
import { requireResearchAccess, rateLimit } from "@/lib/auth";
import { getResearch } from "@/lib/research";
import { projectResearchConfig } from "@/lib/model-settings";
import { confirmDocumentProposal, prepareDocumentProposal } from "@/lib/plan-documents";
import { documentSelectionSchema } from "@/lib/document-proposal";
import { startTaskScheduler } from "@/lib/tasks";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
const documentAction = z.union([
  z.object({ action: z.literal("preview").default("preview"), request: z.string().trim().max(5000).optional() }).strict(),
  z.object({ action: z.literal("generate"), proposalId: z.string().min(1).max(100), documents: documentSelectionSchema }).strict(),
]);
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params, user = await requireResearchAccess(request, id);
    const input = documentAction.parse(await readJson(request, 160000));
    if (input.action === "preview") {
      rateLimit(`plan-document-preview:${user.id}`, 30, 60 * 60_000);
      return Response.json(await prepareDocumentProposal(id, input.request, user.id), { headers: { "Cache-Control": "no-store" } });
    }
    rateLimit(`plan-documents:${user.id}`, 10, 60 * 60_000);
    const pkg = await getResearch(id);
    if (pkg.projectId) await projectResearchConfig(pkg.projectId);
    const result = await confirmDocumentProposal(id, input.proposalId, input.documents, user.id);
    startTaskScheduler();
    return Response.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
