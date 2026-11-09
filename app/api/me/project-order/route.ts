import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { ApiError, errorResponse } from "@/lib/errors";
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    rateLimit(`project-order:${user.id}`, 60, 60000);
    const { stars, projectIds } = z.object({ stars: z.number().int().min(1).max(5), projectIds: z.array(z.string().min(1).max(100)).min(1).max(1000) }).strict().parse(await readJson(request, 120000));
    if (new Set(projectIds).size !== projectIds.length) throw new ApiError(400, "项目不能重复。");
    await db.$transaction(async tx => {
      const members = await tx.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true, personalPriority: { select: { stars: true } } } });
      const peers = members.filter(m => (m.personalPriority?.stars ?? 3) === stars);
      if (peers.length !== projectIds.length || peers.some(m => !projectIds.includes(m.projectId))) throw new ApiError(409, "项目或星级已变化，请刷新后调整顺序。");
      for (const [sortOrder, projectId] of projectIds.entries()) await tx.personalProjectPriority.upsert({ where: { projectId_userId: { projectId, userId: user.id } }, create: { projectId, userId: user.id, stars, sortOrder }, update: { sortOrder } });
    });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
