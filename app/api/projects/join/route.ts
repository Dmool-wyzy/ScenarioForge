import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { joinProject } from "@/lib/projects";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    rateLimit(`join:${user.id}`, 20, 15 * 60 * 1000);
    const { inviteCode } = z.object({ inviteCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/) }).parse(await readJson(request, 8192));
    return Response.json({ project: await joinProject(inviteCode, user.id) });
  } catch (error) { return errorResponse(error); }
}
