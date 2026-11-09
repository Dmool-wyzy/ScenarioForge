import { z } from "zod";
import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { ApiError, errorResponse } from "@/lib/errors";
import { listNextSteps } from "@/lib/next-steps";
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`action-date:${user.id}`, 30, 60000);
    const { actionKey, dueAt } = z.object({ actionKey: z.string().max(140), dueAt: z.string().datetime().nullable() }).strict().parse(await readJson(request, 1024));
    const snapshot = await listNextSteps(user.id, request);
    const action = snapshot.actions.find(a => a.projectId === id && a.id === actionKey);
    if (!action) throw new ApiError(409, "此事项已完成或已不可处理，请刷新待办。");
    if (action.deadlineSource === "task") throw new ApiError(409, "任务描述已有明确截止时间，已自动采用，请刷新待办查看。");
    const date = dueAt ? new Date(dueAt) : null;
    if (date && (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100)) throw new ApiError(400, "请选择 2000–2100 年内的日期。");
    await db.personalActionSetting.upsert({ where: { projectId_userId_actionKey: { projectId: id, userId: user.id, actionKey } }, create: { projectId: id, userId: user.id, actionKey, dueAt: date }, update: { dueAt: date } });
    return Response.json({ dueAt: date });
  } catch (error) { return errorResponse(error); }
}
