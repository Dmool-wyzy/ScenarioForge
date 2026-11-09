import { db } from "@/lib/db";
import { credentialsSchema, rateLimit, requestAddress, signedInResponse, verifyPassword } from "@/lib/auth";
import { ApiError, errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit(`login:${requestAddress(request)}`, 30, 15 * 60 * 1000);
    const { username, password } = credentialsSchema.parse(await readJson(request, 8192));
    rateLimit(`account:${username}`, 15, 15 * 60 * 1000);
    const user = await db.user.findUnique({ where: { username } });
    const verified = await verifyPassword(password, user?.passwordHash);
    if (!user || !verified) throw new ApiError(401, "账号或密码不正确。");
    return await signedInResponse({ id: user.id, username: user.username }, request);
  } catch (error) { return errorResponse(error); }
}
