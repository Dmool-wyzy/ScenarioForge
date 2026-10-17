import { z } from "zod";
import { getResearch } from "@/lib/research";
import { ApiError, errorResponse } from "@/lib/errors";
import { getResearchConfig } from "@/lib/env";
import { queueResearch } from "@/lib/tasks";
import { assertSameOrigin, readJson } from "@/lib/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    getResearchConfig();
    const { id } = await context.params;
    const pkg = await getResearch(id);
    if (["waiting_for_user", "blocked"].includes(pkg.status)) throw new ApiError(409, "请先回答待确认的问题，再继续研究。");
    if (pkg.status === "waiting_for_edit") throw new ApiError(409, "请先保存或取消当前文件编辑，再继续研究。");
    const { message } = z.object({ message: z.string().trim().min(1).max(5000) }).parse(await readJson(request));
    await queueResearch(id, message);
    return Response.json({ status: "queued" }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
