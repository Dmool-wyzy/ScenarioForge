import { ragRoute, type PackageRoute } from "@/lib/rag/api";
import { listEvidence } from "@/lib/rag/retrieval";
export async function GET(request: Request, context: PackageRoute) {
  const params = new URL(request.url).searchParams;
  return ragRoute(request, context, id => listEvidence(id, { sourceType: params.get("sourceType") ?? undefined, page: params.get("page") ?? undefined }));
}
