import { db } from "@/lib/db";
import { rateLimit } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { modelSettingsAccess, storedModelSettings, settingsMetadata, prepareModelSettings, encryptModelSettings } from "@/lib/model-settings";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const { canEdit } = await modelSettingsAccess(request, id);
    return Response.json({ settings: settingsMetadata(await storedModelSettings(id)), canEdit }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { user } = await modelSettingsAccess(request, id, true);
    rateLimit(`model-settings:${user.id}`, 30, 15 * 60 * 1000);
    const { settings } = await prepareModelSettings(id, await readJson(request, 16000));
    await db.project.update({ where: { id }, data: { modelConfigEncrypted: encryptModelSettings(id, settings) } });
    return Response.json({ settings: settingsMetadata(settings), canEdit: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { user } = await modelSettingsAccess(request, id, true);
    rateLimit(`model-settings:${user.id}`, 30, 15 * 60 * 1000);
    await db.project.update({ where: { id }, data: { modelConfigEncrypted: null } });
    return Response.json({ settings: null, canEdit: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
