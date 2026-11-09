import { currentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await currentUser(request);
    const profile = user ? await db.userProfile.findUnique({ where: { userId: user.id }, select: { nickname: true, avatar: true } }) : null;
    return Response.json({ user: user ? { ...user, ...profile } : null }, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return errorResponse(error); }
}
