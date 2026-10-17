import { ragRoute, type PackageRoute } from "@/lib/rag/api";
import { queueRebuild } from "@/lib/rag/indexing";
import { backfillPackage } from "@/lib/rag/backfill";
import { startTaskScheduler } from "@/lib/tasks";
export async function POST(request: Request, context: PackageRoute) {
  return ragRoute(request, context, async id => { await backfillPackage(id); const result = await queueRebuild(id); startTaskScheduler(); return result; });
}
