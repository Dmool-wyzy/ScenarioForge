import { ragRoute, type PackageRoute } from "@/lib/rag/api";
import { ingestLink } from "@/lib/rag/fetch-source";
import { readJson } from "@/lib/validation";
import { startTaskScheduler } from "@/lib/tasks";
export async function POST(request: Request, context: PackageRoute) {
  return ragRoute(request, context, async id => { const result = await ingestLink(id, await readJson(request, 10000)); startTaskScheduler(); return result; });
}
