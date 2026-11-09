import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { encryptPersonalAgentSettings, personalAgentSettingsMetadata, preparePersonalAgentSettings, storedPersonalAgentSettings } from "@/lib/model-settings";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { z } from "zod";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    const target = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable().parse(new URL(request.url).searchParams.get("task"));
    const taskSelect = { id: true, objective: true, context: true, status: true, result: true, conversation: true, revision: true, chatLeaseUntil: true, error: true, modelRequests: true, inputTokens: true, outputTokens: true, createdAt: true, finishedAt: true, package: { select: { id: true, title: true } } } as const;
    const [member, settings, tasks] = await Promise.all([
      db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } }, select: { acceptsAgentTasks: true } }),
      storedPersonalAgentSettings(id, user.id),
      db.agentSubtask.findMany({ where: { assigneeId: user.id, package: { projectId: id } }, orderBy: { createdAt: "desc" }, take: 50,
        select: taskSelect }),
    ]);
    if (target && !tasks.some(task => task.id === target)) {
      const older = await db.agentSubtask.findFirst({ where: { id: target, assigneeId: user.id, package: { projectId: id } }, select: taskSelect });
      if (older) tasks.unshift(older);
    }
    return Response.json({ settings: personalAgentSettingsMetadata(settings), acceptsAgentTasks: member.acceptsAgentTasks, tasks: tasks.map(task => ({ ...task, conversation: JSON.parse(task.conversation), canRecover: task.status === "chatting" && !!task.chatLeaseUntil && task.chatLeaseUntil < new Date() })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`personal-agent:${user.id}`, 30, 15 * 60 * 1000);
    const body = z.object({ acceptsAgentTasks: z.boolean(), settings: z.unknown() }).parse(await readJson(request, 16000));
    const { settings } = await preparePersonalAgentSettings(id, user.id, body.settings);
    await db.projectMember.update({ where: { projectId_userId: { projectId: id, userId: user.id } }, data: {
      acceptsAgentTasks: body.acceptsAgentTasks,
      personalAgentConfigEncrypted: encryptPersonalAgentSettings(id, user.id, settings),
    } });
    return Response.json({ settings: personalAgentSettingsMetadata(settings), acceptsAgentTasks: body.acceptsAgentTasks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`personal-agent:${user.id}`, 30, 15 * 60 * 1000);
    await db.projectMember.update({ where: { projectId_userId: { projectId: id, userId: user.id } }, data: { acceptsAgentTasks: false, personalAgentConfigEncrypted: null } });
    return Response.json({ settings: null, acceptsAgentTasks: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
