import { requireUser } from "@/lib/auth";
import { projectSummary } from "@/lib/projects";
import { errorResponse } from "@/lib/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    return Response.json({ project: await projectSummary((await context.params).id, user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
