import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const base = "https://175.27.143.14";
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0", "Public HTTPS checks require certificate verification.");
const db = new PrismaClient();
const run = randomBytes(6).toString("hex");
const actors = [0, 1].map(index => ({ username: `public_model_${run}_${index}`, password: randomBytes(24).toString("base64url"), cookie: "", id: "" }));
const [owner, member] = actors;
const projectNames = [`Public model settings A ${run}`, `Public model settings B ${run}`];
const projectIds = [];
const apiKey = "fixture-public-key-" + randomBytes(24).toString("hex");
const draft = { baseUrl: "https://example.com/v1", model: "fixture-public-model", apiMode: "responses", timeoutSeconds: 30, apiKey };

async function request(actor, path, method = "GET", body) {
  const headers = {};
  if (actor?.cookie) headers.Cookie = actor.cookie;
  if (method !== "GET") headers.Origin = base;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20000) });
  const cookie = response.headers.get("set-cookie");
  if (actor && cookie) actor.cookie = cookie.split(";", 1)[0];
  return response;
}

async function status(actor, path, expected, method = "GET", body) {
  const response = await request(actor, path, method, body);
  assert.equal(response.status, expected, `${method} ${path}`);
  return response;
}

function assertPrivate(value, ciphertext) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(apiKey) && !text.includes(apiKey.slice(-8)), "Provider key or suffix was disclosed.");
  assert.ok(!text.includes('"modelConfigEncrypted"'), "Model ciphertext field was disclosed.");
  if (ciphertext) assert.ok(!text.includes(ciphertext), "Model ciphertext was disclosed.");
}

async function metadata(actor, path, canEdit, model, ciphertext) {
  const response = await status(actor, path, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.canEdit, canEdit);
  if (model === null) assert.equal(body.settings, null);
  else {
    assert.equal(body.settings.model, model);
    assert.equal(body.settings.baseUrl, draft.baseUrl);
    assert.equal(body.settings.hasApiKey, true);
    assert.equal(body.settings.deepseekSearchEnabled, false);
    assert.deepEqual(Object.keys(body.settings).sort(), ["apiMode", "baseUrl", "deepseekSearchEnabled", "hasApiKey", "model", "timeoutSeconds"].sort());
  }
  assertPrivate(body, ciphertext);
  return body;
}

try {
  for (const actor of actors) {
    const response = await status(actor, "/api/auth/register", 200, "POST", { username: actor.username, password: actor.password });
    const user = (await response.json()).user;
    assert.equal(user.username, actor.username);
    actor.id = user.id;
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie?.startsWith("__Host-scenarioforge_session="), "Production session cookie lacks its __Host- prefix.");
    for (const attribute of [/;\s*Secure(?:;|$)/i, /;\s*HttpOnly(?:;|$)/i, /;\s*SameSite=Lax(?:;|$)/i, /;\s*Path=\/(?:;|$)/i]) assert.ok(attribute.test(cookie), "Production cookie protection is missing.");
    assert.ok(!/;\s*Domain=/i.test(cookie), "A __Host- cookie must not set Domain.");
    assert.equal((await (await status(actor, "/api/auth/me", 200)).json()).user.id, actor.id);
  }
  const projects = [];
  for (const name of projectNames) {
    const project = (await (await status(owner, "/api/projects", 201, "POST", { name })).json()).project;
    assert.equal(project.name, name);
    projectIds.push(project.id);
    projects.push(project);
  }
  const [first, second] = projects;
  await status(member, "/api/projects/join", 200, "POST", { inviteCode: first.inviteCode });
  const firstPath = `/api/projects/${first.id}/model`, secondPath = `/api/projects/${second.id}/model`;
  await metadata(owner, firstPath, true, null);
  assertPrivate(await (await status(owner, firstPath, 200, "PUT", draft)).json());
  const stored = await db.project.findUniqueOrThrow({ where: { id: first.id }, select: { name: true, modelConfigEncrypted: true } });
  assert.equal(stored.name, projectNames[0]);
  assert.ok(stored.modelConfigEncrypted && !stored.modelConfigEncrypted.includes(apiKey), "Production did not encrypt the provider key.");
  await metadata(owner, firstPath, true, draft.model, stored.modelConfigEncrypted);
  await metadata(member, firstPath, false, draft.model, stored.modelConfigEncrypted);
  await status(member, firstPath, 403, "PUT", draft);
  await status(member, firstPath, 403, "DELETE");
  for (const method of ["GET", "PUT", "DELETE"]) {
    await status(member, secondPath, 404, method, method === "PUT" ? draft : undefined);
    await status(null, firstPath, 401, method, method === "PUT" ? draft : undefined);
  }
  const retained = { ...draft, model: "fixture-public-updated-model", apiKey: "" };
  assertPrivate(await (await status(owner, firstPath, 200, "PUT", retained)).json());
  await metadata(owner, firstPath, true, retained.model);
  await metadata(member, firstPath, false, retained.model);
  await metadata(owner, secondPath, true, null);
  await status(owner, firstPath, 200, "DELETE");
  await metadata(owner, firstPath, true, null);
  await metadata(member, firstPath, false, null);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: first.id }, select: { modelConfigEncrypted: true } })).modelConfigEncrypted, null);
  for (const actor of actors) await status(actor, "/api/auth/logout", 200, "POST");
  console.log("PASS: public verified HTTPS, production Secure/HttpOnly/__Host- cookies, owner save/read/clear, production-process decryption, private ciphertext and keyless metadata, read-only member, nonmember and anonymous rejection; no model/test or research requests.");
} finally {
  try {
    if (projectIds.length) {
      const removed = await db.project.deleteMany({ where: { id: { in: projectIds }, name: { in: projectNames }, members: { some: { userId: owner.id, role: "owner" } }, researchPackages: { none: {} } } });
      assert.equal(removed.count, projectIds.length, "Fixture projects changed unexpectedly; preserve their data for review.");
    }
    await db.user.deleteMany({ where: { id: { in: actors.map(actor => actor.id).filter(Boolean) }, username: { in: actors.map(actor => actor.username) } } });
  } finally { await db.$disconnect(); }
}
