import "server-only";
import { getResearch } from "../research";
import { errorResponse } from "../errors";
import { assertSameOrigin } from "../validation";
export type PackageRoute = { params: Promise<{ id: string }> };
export async function ragRoute(request: Request, context: PackageRoute, action: (id: string) => Promise<unknown>) {
  try {
    if (request.method !== "GET") assertSameOrigin(request);
    const { id } = await context.params;
    await getResearch(id);
    return Response.json(await action(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
