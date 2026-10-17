import { ragRoute } from "@/lib/rag/api";
import { getEvidence } from "@/lib/rag/retrieval";
export async function GET(request: Request, context: { params: Promise<{ id: string; evidenceId: string }> }) {
  const { evidenceId } = await context.params;
  return ragRoute(request, context, id => getEvidence(id, evidenceId));
}
