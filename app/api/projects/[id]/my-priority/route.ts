import { z } from "zod";
import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { errorResponse } from "@/lib/errors";
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`priority:${user.id}`, 120, 60000);
    const { stars } = z.object({ stars: z.number().int().min(1).max(5) }).strict().parse(await readJson(request, 1024));
    await db.personalProjectPriority.upsert({ where: { projectId_userId: { projectId: id, userId: user.id } }, create: { projectId: id, userId: user.id, stars }, update: { stars } });
    return Response.json({ stars });
  } catch (error) { return errorResponse(error); }
}
