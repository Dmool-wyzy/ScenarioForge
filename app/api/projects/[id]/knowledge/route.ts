import { z } from "zod";
import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { db } from "@/lib/db";
import { listProjectKnowledge, shareEvidenceWithProject } from "@/lib/project-knowledge";
import { assertSameOrigin, readJson } from "@/lib/validation";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: id, userId: user.id } }, select: { role: true } });
    const params = new URL(request.url).searchParams;
    const query = z.string().trim().max(100).parse(params.get("q") ?? "");
    const includeArchived = params.get("includeArchived") === "true";
    const result = await listProjectKnowledge(id, query, includeArchived);
    return Response.json({ ...result, results: result.results.map(item => ({ ...item, canManage: member.role === "owner" || item.createdBy === user.id })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const user = await requireProjectAccess(request, id);
    rateLimit(`project-knowledge:${user.id}`, 60, 60 * 60 * 1000);
    return Response.json(await shareEvidenceWithProject(id, user.id, await readJson(request, 8192)), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
