import { exportWorkspace } from "@/lib/markdown";
import { getResearch } from "@/lib/research";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await getResearch(id);
    const zip = await exportWorkspace(id);
    return new Response(new Uint8Array(zip), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="scenarioforge-workspace.zip"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
