import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { favoriteDetails, favoriteTarget, resolveFavorite } from "@/lib/favorites";
import { assertSameOrigin, readJson } from "@/lib/validation";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request), query = new URL(request.url).searchParams;
    if (query.has("kind")) {
      const target = favoriteTarget.parse({ kind: query.get("kind"), targetId: query.get("targetId") });
      const row = await db.personalFavorite.findUnique({ where: { userId_kind_targetId: { userId: user.id, ...target } }, select: { id: true } });
      return Response.json({ favorite: row }, { headers: { "Cache-Control": "no-store" } });
    }
    const rows = await db.personalFavorite.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const favorites = [];
    // Limit concurrent database work while resolving potentially revoked references.
    for (let offset = 0; offset < rows.length; offset += 10) {
      favorites.push(...await Promise.all(rows.slice(offset, offset + 10).map(async row => ({ id: row.id, kind: row.kind, tags: JSON.parse(row.tags), note: row.note, createdAt: row.createdAt, source: await resolveFavorite(user.id, row.kind, row.targetId) }))));
    }
    return Response.json({ favorites }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request); rateLimit(`favorites:${user.id}`, 60, 60000);
    const target = favoriteTarget.parse(await readJson(request, 2048));
    if (!await resolveFavorite(user.id, target.kind, target.targetId)) throw new ApiError(404, "内容不存在，或你已无权访问。");
    const key = { userId: user.id, ...target };
    const existing = await db.personalFavorite.findUnique({ where: { userId_kind_targetId: key }, select: { id: true } });
    if (existing) return Response.json({ favorite: existing });
    if (await db.personalFavorite.count({ where: { userId: user.id } }) >= 300) throw new ApiError(400, "收藏已达 300 条，请整理后再添加。");
    const favorite = await db.personalFavorite.upsert({ where: { userId_kind_targetId: key }, create: key, update: {}, select: { id: true } });
    return Response.json({ favorite });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request); rateLimit(`favorites:${user.id}`, 60, 60000);
    const { id, ...details } = favoriteDetails.extend({ id: z.string().min(1).max(100) }).parse(await readJson(request, 10000));
    const result = await db.personalFavorite.updateMany({ where: { id, userId: user.id }, data: { note: details.note, tags: JSON.stringify(details.tags) } });
    if (!result.count) throw new ApiError(404, "未找到收藏。");
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(request); rateLimit(`favorites:${user.id}`, 60, 60000);
    const { id } = z.object({ id: z.string().min(1).max(100) }).strict().parse(await readJson(request, 1024));
    await db.personalFavorite.deleteMany({ where: { id, userId: user.id } });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
