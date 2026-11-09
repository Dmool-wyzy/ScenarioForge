import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";

const base = process.env.SCENARIOFORGE_BACKEND_URL ?? "http://localhost:3000";
const db = new PrismaClient();
const run = randomBytes(6).toString("hex");
const actors = ["owner", "member", "outside"].map((role, index) => ({
  username: `access_${run}_${index}`, password: randomBytes(24).toString("base64url"),
  address: `198.18.${randomBytes(1)[0]}.${index + 1}`, role, cookie: "", id: "",
}));
const [owner, member, outsider] = actors;
const projectIds = [], packageIds = [];

async function request(actor, path, { method = "GET", body, origin = new URL(base).origin } = {}) {
  const headers = { "X-Real-IP": actor?.address ?? "198.18.0.250" };
  if (actor?.cookie) headers.Cookie = actor.cookie;
  if (method !== "GET") headers.Origin = origin;
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const cookie = response.headers.get("set-cookie");
  if (actor && cookie) actor.cookie = cookie.split(";", 1)[0];
  return response;
}

async function expectStatus(actor, path, status, options) {
  const response = await request(actor, path, options);
  assert.equal(response.status, status, `${options?.method ?? "GET"} ${path}`);
  return response;
}

try {
  await expectStatus(null, "/api/projects", 401);
  for (const actor of actors) {
    const response = await expectStatus(actor, "/api/auth/register", 200, { method: "POST", body: { username: actor.username, password: actor.password } });
    const { user } = await response.json();
    actor.id = user.id;
    assert.equal(user.username, actor.username);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie?.includes("HttpOnly") && cookie.includes("SameSite=Lax"), "Session cookie is not protected.");
    assert.equal((await (await expectStatus(actor, "/api/auth/me", 200)).json()).user.id, actor.id);
    const token = actor.cookie.slice(actor.cookie.indexOf("=") + 1);
    const stored = await db.authSession.findUniqueOrThrow({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } });
    assert.equal(stored.userId, actor.id);
    const account = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
    assert.ok(account.passwordHash !== actor.password && account.passwordHash.startsWith("scrypt$"), "Password was not hashed.");
  }
  await expectStatus(owner, "/api/auth/login", 401, { method: "POST", body: { username: owner.username, password: "incorrect-password" } });
  const registrationCookie = owner.cookie;
  await expectStatus(owner, "/api/auth/login", 200, { method: "POST", body: { username: owner.username.toUpperCase(), password: owner.password } });
  assert.ok(owner.cookie !== registrationCookie, "Successful login did not rotate the session.");
  await expectStatus({ ...owner, cookie: registrationCookie }, "/api/projects", 401);
  const signedInCookie = owner.cookie;
  await expectStatus(owner, "/api/auth/logout", 200, { method: "POST" });
  await expectStatus({ ...owner, cookie: signedInCookie }, "/api/projects", 401);
  assert.equal((await (await expectStatus(owner, "/api/auth/me", 200)).json()).user, null);
  await expectStatus(owner, "/api/auth/login", 200, { method: "POST", body: { username: owner.username, password: owner.password } });

  const { project } = await (await expectStatus(owner, "/api/projects", 201, { method: "POST", body: { name: `权限验证 ${run}` } })).json();
  projectIds.push(project.id);
  assert.match(project.inviteCode, /^[A-Z0-9]{6}$/);
  assert.equal(project.role, "owner");
  assert.equal(project.memberCount, 1);
  const second = (await (await expectStatus(owner, "/api/projects", 201, { method: "POST", body: { name: `独立项目 ${run}` } })).json()).project;
  projectIds.push(second.id);
  assert.match(second.inviteCode, /^[A-Z0-9]{6}$/);
  assert.notEqual(second.inviteCode, project.inviteCode);
  assert.deepEqual((await (await expectStatus(member, "/api/projects", 200)).json()).projects, []);
  for (let count = 0; count < 2; count++) {
    const joined = (await (await expectStatus(member, "/api/projects/join", 200, { method: "POST", body: { inviteCode: project.inviteCode.toLowerCase() } })).json()).project;
    assert.equal(joined.id, project.id);
    assert.equal(joined.role, "member");
    assert.equal(joined.memberCount, 2);
  }
  assert.equal(await db.projectMember.count({ where: { projectId: project.id, userId: member.id } }), 1);
  assert.deepEqual((await (await expectStatus(member, "/api/projects", 200)).json()).projects.map(row => row.id), [project.id]);
  await expectStatus(outsider, `/api/projects/${project.id}`, 404);
  await expectStatus(member, `/api/projects/${second.id}`, 404);

  const pkg = await db.researchPackage.create({ data: {
    projectId: project.id, goal: `访问控制自检 ${run}`, title: "权限与编辑锁验证", status: "completed",
    taskState: "running", leaseOwner: `access-${run}`, leaseUntil: new Date(Date.now() + 600000),
    files: { create: { filename: "README.md", content: "# 仅供项目成员读取" } },
  } });
  packageIds.push(pkg.id);
  const legacy = await db.researchPackage.create({ data: { goal: `旧匿名数据 ${run}`, title: "无项目归属", files: { create: { filename: "README.md", content: "# 未认领资料" } } } });
  packageIds.push(legacy.id);
  const resource = `/api/research/${pkg.id}`;
  const file = `${resource}/files/README.md`;
  const lockToken = randomUUID();
  const routes = [
    [resource], [file], [`${resource}/workspace`], [`${resource}/stream`],
    [`${resource}/evidence`], [`${resource}/evidence/EVIDENCE-1`], [`${resource}/knowledge`],
    [file, "PUT", { baseVersion: 1, content: "unauthorized" }],
    [file, "PATCH", { action: "lock", lockToken }],
    [`${resource}/evidence/search`, "POST", { query: "private" }],
    [`${resource}/knowledge/rebuild`, "POST"],
    [`${resource}/sources`, "POST", { url: "https://example.com/" }],
    [`${resource}/messages`, "POST", { message: "unauthorized" }],
    [`${resource}/answer`, "POST", { clarificationId: "fixture", answer: "unauthorized" }],
  ];
  for (const [path, method = "GET", body] of routes) {
    for (const [actor, status] of [[outsider, 404], [null, 401]]) {
      const response = await expectStatus(actor, path, status, { method, body });
      await response.body?.cancel();
    }
  }
  await expectStatus(outsider, "/api/research", 404, { method: "POST", body: { projectId: project.id, goal: "不能在他人项目创建研究" } });
  const damagedUpload = new FormData();
  damagedUpload.set("projectId", project.id);
  damagedUpload.set("goal", "必须先验证项目成员，再解析上传文件");
  damagedUpload.append("files", new File(["PK deliberately invalid DOCX archive"], "broken.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  for (const [actor, status] of [[outsider, 404], [null, 401]]) {
    const rejected = await expectStatus(actor, "/api/research", status, { method: "POST", body: damagedUpload });
    await rejected.body?.cancel();
  }
  await expectStatus(owner, `/api/research/${legacy.id}`, 404);
  await expectStatus(owner, `/api/research/${legacy.id}/files/README.md`, 404);
  assert.equal((await (await expectStatus(member, resource, 200)).json()).id, pkg.id);
  assert.equal(await (await expectStatus(member, file, 200)).text(), "# 仅供项目成员读取");
  const zip = await JSZip.loadAsync(await (await expectStatus(member, `${resource}/workspace`, 200)).arrayBuffer());
  assert.ok(zip.file("README.md"));
  const stream = await expectStatus(member, `${resource}/stream`, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  await stream.body.cancel();

  for (const [path, body] of [
    ["/api/auth/logout"], ["/api/auth/login", { username: owner.username, password: owner.password }],
    ["/api/projects", { name: "cross-origin" }], ["/api/projects/join", { inviteCode: project.inviteCode }],
    [`${resource}/messages`, { message: "cross-origin" }],
  ]) await expectStatus(owner, path, 403, { method: "POST", body, origin: "https://untrusted.example" });
  await expectStatus(owner, file, 403, { method: "PUT", body: { baseVersion: 1, content: "cross-origin" }, origin: "https://untrusted.example" });
  await expectStatus(owner, file, 200, { method: "PATCH", body: { action: "lock", baseVersion: 1, lockToken } });
  for (const action of ["lock", "renew", "unlock"]) await expectStatus(member, file, 423, { method: "PATCH", body: { action, lockToken } });
  await expectStatus(member, file, 423, { method: "PUT", body: { baseVersion: 1, content: "不能偷用他人的锁", lockToken } });
  await expectStatus(owner, file, 409, { method: "PUT", body: { baseVersion: 2, content: "过时版本", lockToken } });
  const saved = await (await expectStatus(owner, file, 200, { method: "PUT", body: { baseVersion: 1, content: "# 成员已保存的计划", lockToken } })).json();
  assert.equal(saved.version, 2);
  await expectStatus(member, file, 409, { method: "PUT", body: { baseVersion: 1, content: "不能覆盖新版本" } });
  const stored = await db.workspaceFile.findUniqueOrThrow({ where: { packageId_filename: { packageId: pkg.id, filename: "README.md" } } });
  assert.equal(stored.content, "# 成员已保存的计划");
  assert.equal(stored.userContent, stored.content);
  assert.equal(stored.lockedBy, null);
  const memberLock = randomUUID();
  await expectStatus(member, file, 200, { method: "PATCH", body: { action: "lock", baseVersion: 2, lockToken: memberLock } });
  await expectStatus(member, file, 200, { method: "PATCH", body: { action: "unlock", lockToken: memberLock } });
  assert.equal(await db.researchEvent.count({ where: { packageId: pkg.id, type: "research_started" } }), 0, "Self-check unexpectedly started an Agent.");
  await expectStatus(outsider, "/api/projects/join", 200, { method: "POST", body: { inviteCode: project.inviteCode } });
  const readers = [];
  for (const actor of actors) {
    const events = await expectStatus(actor, `${resource}/stream`, 200);
    const reader = events.body.getReader();
    let initial = "";
    while (!initial.includes("data:")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Authorized SSE closed before its first event.");
      initial += new TextDecoder().decode(chunk.value);
    }
    readers.push(reader);
  }
  await expectStatus(member, "/api/auth/logout", 200, { method: "POST" });
  await db.authSession.updateMany({ where: { userId: owner.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await db.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: outsider.id } } });
  let deadline;
  try {
    await Promise.race([
      Promise.all(readers.map(async reader => { while (!(await reader.read()).done) { /* Drain events queued before revocation. */ } })),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("SSE stayed open after logout, session expiry or membership removal.")), 18000); }),
    ]);
  } finally { clearTimeout(deadline); }
  await expectStatus(owner, "/api/projects", 401);
  await expectStatus(member, resource, 401);
  await expectStatus(outsider, resource, 404);
  console.log("PASS: registration/session rotation/logout/expiry, project creation/invites/idempotent membership, every research API denies nonmembers and anonymous users, multipart authorization precedes damaged DOCX extraction, legacy privacy, same-origin checks, TLS-backed MySQL, per-user edit locks/version protection, and active SSE closure on logout/expiry/membership removal; no model calls.");
} finally {
  try {
    if (packageIds.length) {
      await db.knowledgeJob.deleteMany({ where: { packageId: { in: packageIds } } });
      await db.evidence.deleteMany({ where: { packageId: { in: packageIds } } });
      await db.researchPackage.deleteMany({ where: { id: { in: packageIds } } });
    }
    if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { username: { in: actors.map(actor => actor.username) } } });
  } finally { await db.$disconnect(); }
}
