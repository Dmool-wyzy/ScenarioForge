import { requireUser, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { personalCenter, profileSchema } from "@/lib/personal-center";
import { assertSameOrigin, readJson } from "@/lib/validation";
import { normalizeAvatar } from "@/lib/avatar";
export async function GET(request: Request) {
  try { const user = await requireUser(request); return Response.json(await personalCenter(user.id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request); rateLimit(`profile:${user.id}`, 30, 60000);
    const input = profileSchema.parse(await readJson(request, 220000));
    const data = { ...input, avatar: await normalizeAvatar(input.avatar), skills: JSON.stringify(input.skills) };
    await db.userProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
    return Response.json({ ok: true, avatar: data.avatar });
  } catch (error) { return errorResponse(error); }
}
