import { ragRoute, type PackageRoute } from "@/lib/rag/api";
import { knowledgeStatus } from "@/lib/rag/knowledge";
export async function GET(request: Request, context: PackageRoute) { return ragRoute(request, context, knowledgeStatus); }
