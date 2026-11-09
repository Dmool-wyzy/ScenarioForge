import { requireResearchAccess } from "@/lib/auth";
import { z } from "zod";
import { getResearch } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { projectResearchConfig } from "@/lib/model-settings";
import { queueResearch } from "@/lib/tasks";
import { assertSameOrigin, readJson } from "@/lib/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    await requireResearchAccess(request, id);
    const pkg = await getResearch(id);
    if (pkg.projectId) await projectResearchConfig(pkg.projectId);
    const { message } = z.object({ message: z.string().trim().min(1).max(5000) }).parse(await readJson(request));
    await queueResearch(id, message, true);
    return Response.json({ status: "queued" }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
