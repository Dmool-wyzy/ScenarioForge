import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/projects";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ projects: await listProjects(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    rateLimit(`project:${user.id}`, 30, 60 * 60 * 1000);
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(await readJson(request, 8192));
    return Response.json({ project: await createProject(name, user.id) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
