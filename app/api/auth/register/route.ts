import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { credentialsSchema, hashPassword, rateLimit, requestAddress, signedInResponse } from "@/lib/auth";
import { ApiError, errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit(`register:${requestAddress(request)}`, 5, 60 * 60 * 1000);
    const { username, password } = credentialsSchema.parse(await readJson(request, 8192));
    const user = await db.user.create({ data: { username, passwordHash: await hashPassword(password) }, select: { id: true, username: true } });
    return await signedInResponse(user, request);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return errorResponse(new ApiError(409, "该账号已注册，请直接登录或更换账号。"));
    return errorResponse(error);
  }
}
