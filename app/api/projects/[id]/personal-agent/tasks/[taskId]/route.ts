import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { interactWithPersonalTask } from "@/lib/personal-agent";
import { assertSameOrigin, readJson } from "@/lib/validation";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    assertSameOrigin(request);
    const { id, taskId } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`personal-task:${user.id}`, 20, 15 * 60000);
    await interactWithPersonalTask(id, user.id, taskId, await readJson(request, 60000), request.signal);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
