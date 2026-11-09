import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { db } from "./db";
import { ApiError } from "./errors";

const deriveKey = promisify(scrypt);
const cookieName = process.env.NODE_ENV === "production" ? "__Host-scenarioforge_session" : "scenarioforge_session";
const sessionSeconds = 7 * 24 * 60 * 60;
export const credentialsSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9_]{3,32}$/, "账号须为 3–32 位字母、数字或下划线。").transform(value => value.toLowerCase()),
  password: z.string().min(8, "密码至少 8 位。").max(128),
});

// shortcut: limits are process-local, use a shared limiter before running multiple web instances.
const attempts = new Map<string, { count: number; until: number }>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (attempts.size > 10000) {
    for (const [entry, value] of attempts) if (value.until <= now) attempts.delete(entry);
    if (attempts.size > 10000) throw new ApiError(429, "请求较多，请稍后重试。");
  }
  const entry = attempts.get(key);
  if (!entry || entry.until <= now) attempts.set(key, { count: 1, until: now + windowMs });
  else if (++entry.count > limit) throw new ApiError(429, "操作过于频繁，请稍后重试。");
}

export function requestAddress(request: Request) {
  return request.headers.get("x-real-ip") ?? "local";
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, hash?: string) {
  const [, salt, expected] = (hash ?? "scrypt$00000000000000000000000000000000$").split("$");
  const key = await deriveKey(password, salt, 64) as Buffer;
  const stored = Buffer.from(expected, "hex");
  return key.length === stored.length && timingSafeEqual(key, stored);
}

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function readToken(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function currentSessionHash(request: Request) {
  const token = readToken(request); return token ? tokenHash(token) : null;
}
function deviceName(request: Request) {
  const ua = request.headers.get("user-agent") ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知系统";
  return `${os} · ${browser}`;
}

export async function currentUser(request: Request) {
  const token = readToken(request);
  if (!token) return null;
  const session = await db.authSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: { select: { id: true, username: true } } } });
  return session && session.expiresAt > new Date() ? session.user : null;
}

export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) throw new ApiError(401, "请先登录。");
  return user;
}

export async function signedInResponse(user: { id: string; username: string }, request: Request) {
  await deleteSession(request);
  await db.authSession.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString("base64url");
  await db.authSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, device: deviceName(request), expiresAt: new Date(Date.now() + sessionSeconds * 1000) } });
  return Response.json({ user }, { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(token, sessionSeconds) } });
}

function sessionCookie(token: string, age: number) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export async function deleteSession(request: Request) {
  const token = readToken(request);
  if (token) await db.authSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
}

export async function signedOutResponse(request: Request) {
  await deleteSession(request);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie("", 0) } });
}

export async function requireProjectAccess(request: Request, projectId: string) {
  const user = await requireUser(request);
  const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: user.id } } });
  if (!member) throw new ApiError(404, "未找到项目，或你尚未加入此项目。");
  return user;
}

export async function requireResearchAccess(request: Request, packageId: string) {
  const user = await requireUser(request);
  const pkg = await db.researchPackage.findUnique({ where: { id: packageId }, select: { projectId: true } });
  if (!pkg?.projectId || !await db.projectMember.findUnique({ where: { projectId_userId: { projectId: pkg.projectId, userId: user.id } } })) throw new ApiError(404, "未找到研究包，或你没有访问权限。");
  return user;
}
