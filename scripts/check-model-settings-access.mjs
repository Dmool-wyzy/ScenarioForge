import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const base = process.env.SCENARIOFORGE_BACKEND_URL ?? "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Run model settings fixtures against the local development server.");
assert.ok(process.env.SCENARIOFORGE_INTERNAL_TOKEN, "Internal configuration is required for snapshot checks.");
const db = new PrismaClient();
const run = randomBytes(6).toString("hex");
const actors = [0, 1, 2].map(index => ({ username: `settings_${run}_${index}`, password: randomBytes(24).toString("base64url"), address: `198.19.${randomBytes(1)[0]}.${index + 1}`, cookie: "", id: "" }));
const [owner, member, outsider] = actors;
const projectIds = [], packageIds = [];
const keys = [0, 1, 2].map(() => "fixture-model-key-" + randomBytes(24).toString("hex"));
const draft = { baseUrl: "https://example.com/v1", model: "fixture-model-a", apiMode: "responses", timeoutSeconds: 30 };

async function request(actor, path, method = "GET", body, origin = new URL(base).origin) {
  const headers = { "X-Real-IP": actor?.address ?? "198.19.0.250" };
  if (actor?.cookie) headers.Cookie = actor.cookie;
  if (method !== "GET") headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const cookie = response.headers.get("set-cookie");
  if (actor && cookie) actor.cookie = cookie.split(";", 1)[0];
  return response;
}

async function status(actor, path, expected, method = "GET", body, origin) {
  const response = await request(actor, path, method, body, origin);
  assert.equal(response.status, expected, `${method} ${path}`);
  return response;
}

function assertNoSecrets(value, encrypted = []) {
  const serialized = JSON.stringify(value);
  for (const key of keys) assert.ok(!serialized.includes(key) && !serialized.includes(key.slice(-8)), "A key or key suffix leaked into a response.");
  for (const cipher of encrypted) assert.ok(!serialized.includes(cipher), "Encrypted model configuration leaked into a context response.");
  assert.ok(!serialized.includes('"modelConfigEncrypted"'), "A context exposed its configuration ciphertext field.");
}

async function metadata(actor, path, canEdit, expectedModel) {
  const response = await status(actor, path, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.canEdit, canEdit);
  if (expectedModel === null) assert.equal(body.settings, null);
  else {
    assert.equal(body.settings.model, expectedModel);
    assert.equal(body.settings.hasApiKey, true);
    assert.equal(body.settings.deepseekSearchEnabled, false);
    assert.deepEqual(Object.keys(body.settings).sort(), ["apiMode", "baseUrl", "deepseekSearchEnabled", "hasApiKey", "model", "timeoutSeconds"].sort());
  }
  assertNoSecrets(body);
  return body;
}

async function internal(packageId, operation, authenticated = true) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated) headers.Authorization = `Bearer ${process.env.SCENARIOFORGE_INTERNAL_TOKEN}`;
  return fetch(new URL(`/api/internal/research/${packageId}`, base), { method: "POST", headers, body: JSON.stringify({ operation }), signal: AbortSignal.timeout(20000) });
}

try {
  for (const actor of actors) {
    const registered = await status(actor, "/api/auth/register", 200, "POST", { username: actor.username, password: actor.password });
    actor.id = (await registered.json()).user.id;
  }
  const projects = [];
  for (const name of [`Model settings A ${run}`, `Model settings B ${run}`]) {
    const project = (await (await status(owner, "/api/projects", 201, "POST", { name })).json()).project;
    projects.push(project);
    projectIds.push(project.id);
  }
  const [first, second] = projects;
  await status(member, "/api/projects/join", 200, "POST", { inviteCode: first.inviteCode });
  const firstPath = `/api/projects/${first.id}/model`, secondPath = `/api/projects/${second.id}/model`;
  await metadata(owner, firstPath, true, null);
  await metadata(member, firstPath, false, null);
  for (const [actor, expected] of [[outsider, 404], [null, 401]]) {
    await status(actor, firstPath, expected);
    for (const method of ["PUT", "DELETE"]) await status(actor, firstPath, expected, method, method === "PUT" ? { ...draft, apiKey: keys[0] } : undefined);
    await status(actor, `${firstPath}/test`, expected, "POST", { ...draft, apiKey: keys[0] });
  }
  for (const method of ["PUT", "DELETE"]) await status(member, firstPath, 403, method, method === "PUT" ? { ...draft, apiKey: keys[0] } : undefined);
  await status(member, `${firstPath}/test`, 403, "POST", { ...draft, apiKey: keys[0] });
  await status(member, secondPath, 404);
  await status(owner, firstPath, 400, "PUT", { ...draft, apiKey: "" });

  for (const baseUrl of ["http://example.com/v1", "https://127.0.0.1/v1", "https://169.254.169.254/v1", "https://10.0.0.1/v1", "https://user:password@example.com/v1", "https://example.com/v1?secret=value", "https://example.com/v1#fragment"]) {
    await status(owner, firstPath, 400, "PUT", { ...draft, baseUrl, apiKey: keys[0] });
  }
  for (const baseUrl of ["http://example.com/v1", "https://169.254.169.254/v1"]) {
    await status(owner, `${firstPath}/test`, 400, "POST", { ...draft, baseUrl, apiKey: keys[0] });
  }
  await status(owner, firstPath, 403, "PUT", { ...draft, apiKey: keys[0] }, "https://untrusted.example");
  await status(owner, `${firstPath}/test`, 403, "POST", { ...draft, apiKey: keys[0] }, "https://untrusted.example");
  await status(owner, firstPath, 403, "DELETE", undefined, "https://untrusted.example");

  assertNoSecrets(await (await status(owner, firstPath, 200, "PUT", { ...draft, apiKey: keys[0] })).json());
  await metadata(owner, firstPath, true, draft.model);
  await metadata(member, firstPath, false, draft.model);
  const beforeRejectedMove = (await db.project.findUniqueOrThrow({ where: { id: first.id }, select: { modelConfigEncrypted: true } })).modelConfigEncrypted;
  for (const baseUrl of ["https://example.net/v1", "https://example.com/other/v1"]) {
    const moveWithoutKey = { ...draft, baseUrl, model: "must-not-save" };
    await status(owner, firstPath, 400, "PUT", moveWithoutKey);
    await status(owner, `${firstPath}/test`, 400, "POST", moveWithoutKey);
  }
  assert.ok((await db.project.findUniqueOrThrow({ where: { id: first.id }, select: { modelConfigEncrypted: true } })).modelConfigEncrypted === beforeRejectedMove, "Changing the endpoint without a new key modified saved credentials.");
  await metadata(owner, firstPath, true, draft.model);
  const retained = { ...draft, model: "fixture-model-retained-key", apiMode: "chat_completions", apiKey: "" };
  assertNoSecrets(await (await status(owner, firstPath, 200, "PUT", retained)).json());
  assertNoSecrets(await (await status(owner, secondPath, 200, "PUT", { ...draft, model: "fixture-model-b", apiKey: keys[1] })).json());
  await metadata(owner, firstPath, true, retained.model);
  await metadata(owner, secondPath, true, "fixture-model-b");

  const snapshots = [];
  for (const project of projects) {
    const stored = await db.project.findUniqueOrThrow({ where: { id: project.id }, select: { modelConfigEncrypted: true } });
    assert.ok(stored.modelConfigEncrypted);
    for (const key of keys) assert.ok(!stored.modelConfigEncrypted.includes(key), "The database stored a plaintext provider key.");
    snapshots.push(stored.modelConfigEncrypted);
    const pkg = await db.researchPackage.create({ data: {
      projectId: project.id, modelConfigEncrypted: stored.modelConfigEncrypted,
      goal: `Model configuration snapshot ${run}`, title: "Model snapshot fixture", status: "researching",
      taskState: "running", leaseOwner: `model-settings-${run}`, leaseUntil: new Date(Date.now() + 600000),
    } });
    packageIds.push(pkg.id);
  }
  await status(owner, firstPath, 200, "PUT", { ...draft, baseUrl: "https://example.net/v1", model: "fixture-model-next-round", apiKey: keys[2] });
  await metadata(owner, firstPath, true, "fixture-model-next-round");
  await metadata(owner, secondPath, true, "fixture-model-b");
  for (const [index, packageId] of packageIds.entries()) {
    const configResponse = await internal(packageId, "model_config");
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    const config = await configResponse.json();
    assert.ok(config.OPENAI_API_KEY === keys[index], "The active research snapshot changed its provider key.");
    assert.equal(config.SCENARIOFORGE_MODEL, index === 0 ? retained.model : "fixture-model-b");
    assert.equal(config.OPENAI_API_MODE, index === 0 ? "chat_completions" : "responses");
    assert.equal(config.PROJECT_MODEL_CONFIG, true);
    const privateContext = await internal(packageId, "context");
    assert.equal(privateContext.status, 200);
    assertNoSecrets(await privateContext.json(), snapshots);
    const publicContext = await status(owner, `/api/research/${packageId}`, 200);
    assertNoSecrets(await publicContext.json(), snapshots);
    assert.equal((await internal(packageId, "model_config", false)).status, 401);
  }
  await status(owner, firstPath, 200, "DELETE");
  await metadata(owner, firstPath, true, null);
  await metadata(member, firstPath, false, null);
  await metadata(owner, secondPath, true, "fixture-model-b");
  const active = await (await internal(packageIds[0], "model_config")).json();
  assert.ok(active.OPENAI_API_KEY === keys[0], "Clearing future project settings invalidated the active snapshot.");
  await status(owner, secondPath, 200, "DELETE");
  await metadata(owner, secondPath, true, null);
  assert.equal(await db.researchEvent.count({ where: { packageId: { in: packageIds }, type: "research_started" } }), 0, "The fixture unexpectedly started an Agent.");
  console.log("PASS: owner-only model settings, keyless metadata, no key suffix disclosure, safe URL validation before tests, empty-key retention, new-key requirement for endpoint changes, two-project isolation, active-round snapshots, private context redaction and clear; no provider requests or paid model calls.");
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
