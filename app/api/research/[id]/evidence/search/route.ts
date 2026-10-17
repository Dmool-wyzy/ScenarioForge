import { ragRoute, type PackageRoute } from "@/lib/rag/api";
import { searchEvidence } from "@/lib/rag/retrieval";
import { readJson } from "@/lib/validation";
export async function POST(request: Request, context: PackageRoute) {
  return ragRoute(request, context, async id => searchEvidence(id, await readJson(request, 10000)));
}
