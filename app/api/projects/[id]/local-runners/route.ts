import { z } from "zod";
import { requireProjectAccess, rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { createRunnerPairing, listProjectRunners, revokeProjectRunner } from "@/lib/workspace-agent/local-runner";
import { assertSameOrigin, readJson } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pair"), label: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("revoke"), runnerId: z.string().min(1).max(100) }),
]);
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params, user = await requireProjectAccess(request, id);
    return Response.json({ runners: await listProjectRunners(id, user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params, user = await requireProjectAccess(request, id);
    rateLimit("local-runner:" + user.id, 10, 15 * 60_000);
    const input = bodySchema.parse(await readJson(request));
    if (input.action === "pair") return Response.json(await createRunnerPairing(id, user.id, input.label), { status: 201, headers: { "Cache-Control": "no-store" } });
    await revokeProjectRunner(id, user.id, input.runnerId);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
