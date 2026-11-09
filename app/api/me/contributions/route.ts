import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { changeContribution, contributionReview, listContributions } from "@/lib/contributions";
import { assertSameOrigin, readJson } from "@/lib/validation";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request), query = new URL(request.url).searchParams;
    const project = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable().parse(query.get("project"));
    const data = query.get("view") === "review" ? await contributionReview(user.id, z.string().min(1).parse(project))
      : await listContributions(user.id, project, z.coerce.number().int().min(1).max(10000).parse(query.get("page") ?? 1));
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request); rateLimit(`contribution:${user.id}`, 60, 60000);
    return Response.json(await changeContribution(user.id, await readJson(request, 8000)));
  } catch (error) { return errorResponse(error); }
}
