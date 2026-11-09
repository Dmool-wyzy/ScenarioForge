import { z } from "zod";
import { credentialsSchema, currentSessionHash, hashPassword, rateLimit, requireUser, signedInResponse, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request), hash = currentSessionHash(request);
    const rows = await db.authSession.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { id: true, tokenHash: true, device: true, createdAt: true, expiresAt: true } });
    return Response.json({ sessions: rows.map(({ tokenHash, ...row }) => ({ ...row, current: tokenHash === hash })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request);
    rateLimit(`security:${user.id}`, 10, 15 * 60000);
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("password"), currentPassword: z.string().min(1).max(128), newPassword: credentialsSchema.shape.password }).strict(),
      z.object({ action: z.literal("revoke-others") }).strict(),
      z.object({ action: z.literal("revoke"), sessionId: z.string().min(1).max(100) }).strict(),
    ]).parse(await readJson(request, 8192));
    const hash = currentSessionHash(request)!;
    if (input.action !== "password") {
      await db.authSession.deleteMany({ where: { userId: user.id, tokenHash: { not: hash }, ...(input.action === "revoke" ? { id: input.sessionId } : {}) } });
      return Response.json({ ok: true });
    }
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (!await verifyPassword(input.currentPassword, stored.passwordHash)) throw new ApiError(400, "当前密码不正确。");
    if (input.newPassword === input.currentPassword) throw new ApiError(400, "新密码不能与当前密码相同。");
    const passwordHash = await hashPassword(input.newPassword);
    await db.$transaction(async tx => {
      const updated = await tx.user.updateMany({ where: { id: user.id, passwordHash: stored.passwordHash }, data: { passwordHash } });
      if (!updated.count) throw new ApiError(409, "密码已变化，请重新登录后操作。");
      await tx.authSession.deleteMany({ where: { userId: user.id } });
    });
    return signedInResponse(user, request);
  } catch (error) { return errorResponse(error); }
}
