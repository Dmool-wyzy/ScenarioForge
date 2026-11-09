import { requireUser, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { preferencesSchema } from "@/lib/personal-center";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request); rateLimit(`preferences:${user.id}`, 30, 60000);
    const data = preferencesSchema.parse(await readJson(request, 16000));
    await db.userProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
