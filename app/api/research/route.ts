import { createResearch } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { getResearchConfig } from "@/lib/env";
import { queueResearch } from "@/lib/tasks";
import { parseResearchUpload } from "@/lib/uploads";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = request.headers.get("content-type")?.includes("multipart/form-data") ? await parseResearchUpload(request) : await readJson(request);
    getResearchConfig();
    const pkg = await createResearch(input);
    await queueResearch(pkg.id, "开始研究用户目标。");
    return Response.json({ packageId: pkg.id, status: "created" }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
