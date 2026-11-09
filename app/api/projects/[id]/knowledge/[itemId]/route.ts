import { z } from "zod";
import { requireProjectAccess } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";

type Context = { params: Promise<{ id: string; itemId: string }> };

async function updateArchive(request: Request, context: Context, archived: boolean) {
  try {
    assertSameOrigin(request);
    const { id, itemId } = await context.params;
    const user = await requireProjectAccess(request, id);
    const item = await db.projectKnowledgeItem.findFirst({ where: { id: itemId, projectId: id } });
    if (!item) throw new ApiError(404, "未找到项目共享资料。");
    const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } }, select: { role: true } });
    if (member.role !== "owner" && item.createdBy !== user.id) throw new ApiError(403, "只有资料添加者或项目创建者可以管理此共享资料。");
    return Response.json(await db.projectKnowledgeItem.update({ where: { id: item.id }, data: { archivedAt: archived ? new Date() : null }, select: { id: true, archivedAt: true } }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { archived } = z.object({ archived: z.boolean() }).parse(await readJson(request, 8192));
    return updateArchive(request, context, archived);
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context) { return updateArchive(request, context, true); }
