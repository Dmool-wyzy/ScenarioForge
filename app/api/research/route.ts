import { z } from "zod";
import { requireUser, requireProjectAccess, rateLimit } from "@/lib/auth";
import { createResearch } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { projectResearchConfig } from "@/lib/model-settings";
import { queueResearch } from "@/lib/tasks";
import { parseResearchUpload } from "@/lib/uploads";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    rateLimit(`research:${user.id}`, 20, 60 * 60 * 1000);
    let projectId = "";
    const validateProject = async (value: unknown) => {
      projectId = z.string().min(1).max(100).parse(value);
      await requireProjectAccess(request, projectId);
      await projectResearchConfig(projectId);
    };
    const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
    const input = multipart ? await parseResearchUpload(request, validateProject) : await readJson(request);
    if (!multipart) await validateProject(z.object({ projectId: z.unknown() }).parse(input).projectId);
    const pkg = await createResearch(input, projectId);
    await queueResearch(pkg.id, pkg.goal);
    return Response.json({ packageId: pkg.id, status: "created" }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
