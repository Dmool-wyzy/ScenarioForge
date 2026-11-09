import { requireUser } from "@/lib/auth";
import { listNextSteps } from "@/lib/next-steps";
import { errorResponse } from "@/lib/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const user = await requireUser(request); return Response.json(await listNextSteps(user.id, request), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
