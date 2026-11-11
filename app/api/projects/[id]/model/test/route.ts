import { rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { modelSettingsAccess, prepareModelSettings } from "@/lib/model-settings";
import { modelTestRequestSchema, testModelConnection } from "@/lib/model-test";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { user } = await modelSettingsAccess(request, id, true);
    rateLimit(`model-test:${user.id}`, 5, 60 * 1000);
    const input = modelTestRequestSchema.parse(await readJson(request, 16000));
    const { settings, address } = await prepareModelSettings(id, input);
    return Response.json(await testModelConnection(settings, address, input.testKind), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
