import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Model } from "@openai/agents";
import type { SkillFile, Verification } from "../lib/workspace-agent/types";

// This test is opt-in and never migrates a database. Validate the explicit target
// before importing application code, then block every provider/HTTP request.
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "请先指定独立测试库 SCENARIOFORGE_TEST_DATABASE_URL；尚未导入或连接数据库。");
assert.equal(process.env.DATABASE_URL, databaseUrl, "DATABASE_URL 必须与显式指定的独立测试库相同；拒绝连接。");
const target = new URL(databaseUrl);
assert.equal(target.protocol, "mysql:", "本验收仅允许显式指定的 MySQL 测试库。");
assert.match(target.pathname, /^\/scenarioforge_test_[a-z0-9_]{1,45}$/i, "测试库名必须以 scenarioforge_test_ 开头；拒绝连接。");

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function within<T>(promise: Promise<T>, label: string, milliseconds = 30_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("验收等待超时：" + label)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test("isolated MySQL validates local Runner pairing, permissions, durable commands and scripted execution", { timeout: 180_000 }, async t => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(tmpdir(), "sf-local-runner-db-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  process.env.SCENARIOFORGE_ENV_FILE = "";
  process.env.SCENARIOFORGE_TASK_SCHEDULER = "off";
  process.env.SCENARIOFORGE_PUBLIC_ORIGIN = "http://localhost";
  process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
  process.env.RAG_ENABLED = "false";
  globalThis.fetch = async () => { throw new Error("本地 Runner 数据库验收禁止 HTTP 请求或真实模型调用。"); };
  const [{ db }, { Usage }, local, store, jobs, filesystem, route, runnerRoute, pairRoute, exchangeRoute] = await Promise.all([
    import("../lib/db"), import("@openai/agents"), import("../lib/workspace-agent/local-runner"),
    import("../lib/workspace-agent/store"), import("../lib/workspace-agent/jobs"), import("../lib/local-runner/filesystem"),
    import("../app/api/projects/[id]/executions/route"), import("../app/api/local-runner/[id]/commands/route"),
    import("../app/api/projects/[id]/local-runners/route"),
    import("../app/api/local-runner/pair/route"),
  ]);
  const stamp = randomBytes(5).toString("hex"), users: { id: string; token: string; username: string }[] = [], projectIds: string[] = [];
  const openSnapshots = new Set<string>();
  const cookieName = process.env.NODE_ENV === "production" ? "__Host-scenarioforge_session" : "scenarioforge_session";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (user: typeof users[number] | null, projectId: string, action?: unknown, suffix = "", resource = "executions") => {
    const headers = new Headers();
    if (user) headers.set("Cookie", cookieName + "=" + user.token);
    if (action !== undefined) { headers.set("Origin", "http://localhost"); headers.set("Content-Type", "application/json"); }
    return new Request("http://localhost/api/projects/" + projectId + "/" + resource + suffix, { headers, method: action === undefined ? "GET" : "POST",
      ...(action === undefined ? {} : { body: JSON.stringify(action) }) });
  };
  const runnerRequest = (id: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") => new Request("http://localhost/api/local-runner/" + id + "/commands", {
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    for (const role of ["owner", "member", "outsider"]) {
      const user = await db.user.create({ data: { username: "lr_" + stamp + "_" + role, passwordHash: "test-only-no-password" } });
      const token = randomBytes(32).toString("base64url");
      users.push({ ...user, token });
      await db.authSession.create({ data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 600_000) } });
    }
    const [owner, member, outsider] = users;
    const project = await db.project.create({ data: { name: "Local Runner acceptance " + stamp, inviteCode: randomBytes(3).toString("hex").toUpperCase(),
      repositoryEnabled: false, members: { create: [{ userId: owner.id, role: "owner" }, { userId: member.id, role: "member" }] } } });
    projectIds.push(project.id);
    const packageFor = (title: string) => db.researchPackage.create({ data: { projectId: project.id, title: stamp + " " + title, goal: "本地 Runner 验收", status: "replied" } });
    const pairedRunner = async (label: string) => {
      const paired = await local.createRunnerPairing(project.id, owner.id, label);
      const credentials = await local.exchangeRunnerPairing(paired.code);
      await local.authorizeRunner(credentials.runnerId, credentials.token);
      return credentials;
    };

    await t.test("pairing is single-use, credentials are hashed, revocation and project membership are enforced", async () => {
      assert.equal((await pairRoute.POST(request(outsider, project.id, { action: "pair", label: "Denied" }, "", "local-runners"), context(project.id))).status, 404);
      const response = await pairRoute.POST(request(owner, project.id, { action: "pair", label: "Pairing fixture" }, "", "local-runners"), context(project.id));
      assert.equal(response.status, 201);
      const pairing = await response.json() as { id: string; code: string };
      const stored = await db.localRunner.findUniqueOrThrow({ where: { id: pairing.id } });
      assert.notEqual(stored.pairingHash, pairing.code); assert.equal(stored.pairingHash, hash(pairing.code));
      const attempts = await Promise.allSettled([local.exchangeRunnerPairing(pairing.code), local.exchangeRunnerPairing(pairing.code)]);
      const success = attempts.find(result => result.status === "fulfilled");
      assert.ok(success?.status === "fulfilled"); assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
      const credentials = success.value;
      const saved = await db.localRunner.findUniqueOrThrow({ where: { id: pairing.id } });
      assert.equal(saved.pairingHash, null); assert.equal(saved.tokenHash, hash(credentials.token)); assert.notEqual(saved.tokenHash, credentials.token);
      assert.equal(saved.workspaceDirectory, null, "old CLI pairing remains compatible without inventing a directory");
      await assert.rejects(local.exchangeRunnerPairing(pairing.code), /配对码/);
      await assert.rejects(local.authorizeRunner(pairing.id, randomUUID()), /令牌无效/);
      await local.authorizeRunner(pairing.id, credentials.token);
      assert.equal((await pairRoute.POST(request(member, project.id, { action: "revoke", runnerId: pairing.id }, "", "local-runners"), context(project.id))).status, 404);
      await db.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: owner.id } } });
      try {
        await assert.rejects(local.authorizeRunner(pairing.id, credentials.token), /失去项目权限/);
        assert.equal((await runnerRoute.GET(runnerRequest(pairing.id, credentials.token), context(pairing.id))).status, 403);
      } finally { await db.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: "owner" } }); }
      await local.revokeProjectRunner(project.id, owner.id, pairing.id);
      await assert.rejects(local.authorizeRunner(pairing.id, credentials.token), /令牌无效/);
      assert.equal((await runnerRoute.GET(runnerRequest(pairing.id, credentials.token), context(pairing.id))).status, 401);
      const expired = await local.createRunnerPairing(project.id, owner.id, "Expired pairing");
      await db.localRunner.update({ where: { id: expired.id }, data: { pairingExpires: new Date(Date.now() - 1000) } });
      await assert.rejects(local.exchangeRunnerPairing(expired.code), /配对码/);
    });

    await t.test("pairing accepts the Runner's absolute directory and invalid metadata does not consume the code", async () => {
      const paired = await local.createRunnerPairing(project.id, owner.id, "Directory-aware pair");
      const directory = "D:\\lab\\研究项目";
      const exchange = (workspaceDirectory: string) => exchangeRoute.POST(new Request("http://localhost/api/local-runner/pair", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: paired.code, workspaceDirectory }),
      }));
      assert.equal((await exchange("relative/project")).status, 400);
      assert.notEqual((await db.localRunner.findUniqueOrThrow({ where: { id: paired.id } })).pairingHash, null);
      const response = await exchange(directory);
      assert.equal(response.status, 200);
      const credentials = await response.json() as { runnerId: string; token: string };
      assert.equal(credentials.runnerId, paired.id);
      assert.equal((await db.localRunner.findUniqueOrThrow({ where: { id: paired.id } })).workspaceDirectory, directory);
      await local.revokeProjectRunner(project.id, owner.id, credentials.runnerId);
    });

    await t.test("legacy directory reporting is authorized, immutable and frozen per execution even after revocation", async () => {
      const credentials = await pairedRunner("Legacy directory report");
      const body = { workspaceDirectory: "/home/lab/Research" };
      const put = (token: string, directory = body.workspaceDirectory) => runnerRoute.PUT(runnerRequest(credentials.runnerId, token, { workspaceDirectory: directory }, "PUT"), context(credentials.runnerId));
      const before = await packageFor("Unknown old directory");
      const unknown = await store.createExecution(project.id, owner.id, { packageId: before.id, request: "Unknown legacy root", skillIds: [], target: "local", runnerId: credentials.runnerId });
      assert.equal(unknown.execution.workspaceDirectory, null);
      await store.controlExecution(project.id, owner.id, unknown.execution.id, "stop");
      assert.equal((await put(randomUUID())).status, 401);
      assert.equal((await put(credentials.token, "relative/project")).status, 400);
      await db.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: owner.id } } });
      try { assert.equal((await put(credentials.token)).status, 403); }
      finally { await db.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: "owner" } }); }
      assert.equal((await put(credentials.token)).status, 200);
      assert.equal((await put(credentials.token)).status, 200, "same directory reporting is idempotent");
      assert.equal((await put(credentials.token, "/home/lab/research")).status, 409, "case-insensitive SQL collation must not allow a different POSIX root");
      assert.equal((await local.listProjectRunners(project.id, owner.id)).find(item => item.id === credentials.runnerId)?.workspaceDirectory, body.workspaceDirectory);
      assert.ok(!(await local.listProjectRunners(project.id, member.id)).some(item => item.id === credentials.runnerId));
      const after = await packageFor("Known directory snapshot");
      const known = await store.createExecution(project.id, owner.id, { packageId: after.id, request: "Freeze the real directory", skillIds: [], target: "local", runnerId: credentials.runnerId });
      assert.equal(known.execution.workspaceDirectory, body.workspaceDirectory);
      assert.equal((await put(credentials.token, "/home/lab/Other")).status, 409);
      await store.controlExecution(project.id, owner.id, known.execution.id, "stop");
      await local.revokeProjectRunner(project.id, owner.id, credentials.runnerId);
      assert.equal((await put(credentials.token)).status, 401);
      const row = await db.workspaceExecution.findUniqueOrThrow({ where: { id: known.execution.id } });
      assert.equal(store.executionView(row).workspaceDirectory, body.workspaceDirectory);
      assert.equal((await db.workspaceExecution.findUniqueOrThrow({ where: { id: unknown.execution.id } })).workspaceDirectory, null, "later reports never rewrite unknown history");
      const publicList = await (await route.GET(request(member, project.id), context(project.id))).json();
      assert.ok(!JSON.stringify(publicList).includes(body.workspaceDirectory));
    });

    const runner = await pairedRunner("Local selected directory");
    const newExecution = async (label: string, skillIds: string[] = []) => {
      const pkg = await packageFor(label);
      return store.createExecution(project.id, owner.id, { packageId: pkg.id, request: label, skillIds, target: "local", runnerId: runner.runnerId });
    };
    const runRow = (id: string) => db.workspaceExecution.findUniqueOrThrow({ where: { id } });

    await t.test("one local Runner accepts only one active task across conversations without a server repository", async () => {
      const [first, second] = await Promise.all([packageFor("Concurrent one"), packageFor("Concurrent two")]);
      const starts = await Promise.allSettled([first, second].map(pkg => store.createExecution(project.id, owner.id, {
        packageId: pkg.id, request: "Concurrent local start", skillIds: [], target: "local", runnerId: runner.runnerId,
      })));
      assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
      const rejected = starts.find(result => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && /已有执行任务/.test(String(rejected.reason)));
      const active = await db.workspaceExecution.findMany({ where: { runnerId: runner.runnerId, status: { in: ["queued", "running", "stopping"] } } });
      assert.equal(active.length, 1); assert.equal(active[0].target, "local"); assert.equal(active[0].baseCommit, null);
      assert.ok(active[0].branch?.startsWith("local/"));
      await assert.rejects(store.createExecution(project.id, member.id, { request: "Cannot use another user's local files", skillIds: [], target: "local", runnerId: runner.runnerId }), /未连接/);
      await store.controlExecution(project.id, owner.id, active[0].id, "stop");
      const later = await newExecution("Next local task");
      assert.equal(later.execution.target, "local");
      await store.controlExecution(project.id, owner.id, later.execution.id, "stop");
      const resumes = await Promise.allSettled([active[0].id, later.execution.id].map(id => store.controlExecution(project.id, owner.id, id, "resume")));
      assert.equal(resumes.filter(result => result.status === "fulfilled").length, 1);
      const resumed = await db.workspaceExecution.findFirstOrThrow({ where: { runnerId: runner.runnerId, status: "queued" } });
      await store.controlExecution(project.id, owner.id, resumed.id, "stop");
    });

    await t.test("command claims are once-only and reject expired, stopped and stale execution leases", async () => {
      const created = await newExecution("Command protocol"), id = created.execution.id, lease = randomUUID();
      await db.workspaceExecution.update({ where: { id }, data: { status: "running", leaseOwner: lease, leaseUntil: new Date(Date.now() + 120_000) } });
      const commandFor = (extra: { executionLease?: string; expiresAt?: Date; status?: string } = {}) => db.localRunnerCommand.create({ data: {
        id: randomUUID(), runnerId: runner.runnerId, executionId: id, executionLease: lease, operation: "list", input: "{}", expiresAt: new Date(Date.now() + 60_000), ...extra,
      } });
      const command = await commandFor();
      const claims = await Promise.all([local.claimRunnerCommand(runner.runnerId), local.claimRunnerCommand(runner.runnerId)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claimed = claims.find(Boolean)!;
      assert.equal(claimed.id, command.id);
      await assert.rejects(local.completeRunnerCommand(runner.runnerId, command.id, "wrong-lease", {}), /租约/);
      const delivery = { commandId: command.id, leaseOwner: claimed.leaseOwner, result: { head: "a".repeat(40), files: [], total: 0 } };
      assert.equal((await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, delivery), context(runner.runnerId))).status, 200);
      assert.equal((await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, delivery), context(runner.runnerId))).status, 200);
      await assert.rejects(local.completeRunnerCommand(runner.runnerId, command.id, claimed.leaseOwner, {}), /租约/);
      const expired = await commandFor({ expiresAt: new Date(Date.now() - 1000) });
      assert.equal(await local.claimRunnerCommand(runner.runnerId), null);
      assert.equal((await db.localRunnerCommand.findUniqueOrThrow({ where: { id: expired.id } })).status, "pending");
      const stale = await commandFor({ executionLease: randomUUID() });
      assert.equal(await local.claimRunnerCommand(runner.runnerId), null);
      assert.equal((await db.localRunnerCommand.findUniqueOrThrow({ where: { id: stale.id } })).status, "failed");
      const forStopped = await commandFor();
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", leaseOwner: null, leaseUntil: null } });
      assert.equal(await local.claimRunnerCommand(runner.runnerId), null);
      await db.localRunnerCommand.update({ where: { id: forStopped.id }, data: { status: "failed" } });
      await db.workspaceExecution.update({ where: { id }, data: { status: "running", leaseOwner: lease, leaseUntil: new Date(Date.now() + 120_000) } });
      const delayed = await commandFor(), lateClaim = await local.claimRunnerCommand(runner.runnerId);
      assert.equal(lateClaim?.id, delayed.id);
      await db.workspaceExecution.update({ where: { id }, data: { leaseOwner: randomUUID() } });
      const late = await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, { commandId: delayed.id, leaseOwner: lateClaim!.leaseOwner, result: {} }), context(runner.runnerId));
      assert.equal(late.status, 404);
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", leaseOwner: null, leaseUntil: null } });
    });

    await t.test("host command approvals are private, immutable and bound to one live execution lease", async () => {
      const pairing = await local.createRunnerPairing(project.id, member.id, "Member command approval");
      const credentials = await local.exchangeRunnerPairing(pairing.code);
      await local.authorizeRunner(credentials.runnerId, credentials.token);
      const pkg = await packageFor("Member command protocol");
      const created = await store.createExecution(project.id, member.id, { packageId: pkg.id, request: "Test approval only", skillIds: [], target: "local", runnerId: credentials.runnerId });
      const id = created.execution.id, lease = randomUUID(), head = "d".repeat(40), command = ["node", "--test", "tests/only-this.test.mjs"];
      await db.workspaceExecution.update({ where: { id }, data: { status: "running", head, leaseOwner: lease, leaseUntil: new Date(Date.now() + 120_000) } });
      const queued = await db.localRunnerCommand.create({ data: { id: randomUUID(), runnerId: credentials.runnerId, executionId: id, executionLease: lease,
        operation: "exec", status: "approval", input: JSON.stringify({ head, command, receiptBudget: 100000 }), expiresAt: new Date(Date.now() + 60_000) } });
      assert.equal(await local.claimRunnerCommand(credentials.runnerId), null, "Unapproved commands must never reach a Runner.");
      const body = { action: "approve_command", executionId: id, commandId: queued.id };
      assert.equal((await route.POST(request(owner, project.id, body), context(project.id))).status, 404, "Project owner cannot approve another member's host command.");
      assert.equal((await route.POST(request(outsider, project.id, body), context(project.id))).status, 404);
      const memberView = await (await route.GET(request(member, project.id), context(project.id))).json();
      assert.deepEqual(memberView.executions.find((run: { id: string }) => run.id === id).commandApprovals, [{ id: queued.id, head, command, expiresAt: queued.expiresAt.toISOString() }]);
      const ownerView = await (await route.GET(request(owner, project.id), context(project.id))).json();
      assert.ok(!JSON.stringify(ownerView).includes(queued.id));
      assert.equal((await route.POST(request(member, project.id, { ...body, command: ["node", "-e", "unsafe"] }), context(project.id))).status, 400, "Approval cannot rewrite argv.");
      const crossOrigin = request(member, project.id, body); crossOrigin.headers.set("Origin", "https://untrusted.example");
      assert.equal((await route.POST(crossOrigin, context(project.id))).status, 403);
      const decisions = await Promise.all([route.POST(request(member, project.id, body), context(project.id)), route.POST(request(member, project.id, body), context(project.id))]);
      assert.equal(decisions.filter(response => response.status === 200).length, 1, "Exactly one approval is accepted.");
      const claim = await local.claimRunnerCommand(credentials.runnerId); assert.equal(claim?.id, queued.id);
      assert.equal(await local.claimRunnerCommand(credentials.runnerId), null);
      const permit = { commandId: queued.id, leaseOwner: claim!.leaseOwner, action: "start" };
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, permit), context(credentials.runnerId))).status, 200);
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, permit), context(credentials.runnerId))).status, 409, "A start permit is one-shot.");
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, { ...permit, action: "confirm" }), context(credentials.runnerId))).status, 200);
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopping" } });
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, { ...permit, action: "confirm" }), context(credentials.runnerId))).status, 409);
      await db.workspaceExecution.update({ where: { id }, data: { status: "running", leaseOwner: randomUUID() } });
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, { ...permit, action: "confirm" }), context(credentials.runnerId))).status, 409);
      await db.workspaceExecution.update({ where: { id }, data: { leaseOwner: lease } });
      await local.revokeProjectRunner(project.id, member.id, credentials.runnerId);
      assert.equal((await runnerRoute.POST(runnerRequest(credentials.runnerId, credentials.token, { ...permit, action: "confirm" }), context(credentials.runnerId))).status, 401);
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", leaseOwner: null, leaseUntil: null } });
    });

    await t.test("declined and expired approvals never run and a completed command updates the saved local review", async () => {
      const created = await newExecution("Round-trip command result"), id = created.execution.id, lease = randomUUID(), head = "e".repeat(40);
      await db.workspaceExecution.update({ where: { id }, data: { status: "running", head, leaseOwner: lease, leaseUntil: new Date(Date.now() + 120_000) } });
      const workspace = new local.LocalRunnerWorkspace(id, runner.runnerId, null, undefined, lease);
      const waitApproval = async () => within((async () => {
        for (;;) { const row = await db.localRunnerCommand.findFirst({ where: { executionId: id, status: "approval" } }); if (row) return row; await pause(10); }
      })(), "command approval");
      const rejectedResult = workspace.runCommand(head, ["node", "--test"]), rejected = await waitApproval();
      await local.decideLocalCommand(project.id, owner.id, id, rejected.id, false);
      assert.equal((await rejectedResult).status, "unavailable");
      assert.equal(await local.claimRunnerCommand(runner.runnerId), null);
      const expiredResult = workspace.runCommand(head, ["node", "--version"]), expired = await waitApproval();
      await db.localRunnerCommand.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await expiredResult).status, "unavailable");
      await assert.rejects(local.decideLocalCommand(project.id, owner.id, id, expired.id, true), /审批命令/);
      const command = ["node", "tests/create-report.mjs"], resultPromise = workspace.runCommand(head, command), approved = await waitApproval();
      await local.decideLocalCommand(project.id, owner.id, id, approved.id, true);
      const claimed = await local.claimRunnerCommand(runner.runnerId); assert.equal(claimed?.id, approved.id);
      await local.confirmRunnerCommand(runner.runnerId, approved.id, claimed!.leaseOwner, true);
      const nextHead = "f".repeat(40), result = { head: nextHead, beforeHead: head, command, kind: "command", status: "failed", output: "Command changed files; verify again.",
        entries: [{ path: "generated.md", before: null, after: "Created by command" }, { path: "removed.md", before: "Old", after: null }] };
      const receipt = { commandId: approved.id, leaseOwner: claimed!.leaseOwner, result };
      assert.equal((await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, receipt), context(runner.runnerId))).status, 200);
      assert.equal((await resultPromise).head, nextHead);
      assert.equal((await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, receipt), context(runner.runnerId))).status, 200);
      const saved = await runRow(id), review = JSON.parse(saved.localReview!);
      assert.equal(review.head, nextHead); assert.deepEqual(review.entries, result.entries);
      assert.equal((await db.localRunnerCommand.findUniqueOrThrow({ where: { id: approved.id } })).input, "{}");
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", leaseOwner: null, leaseUntil: null } });
    });

    await t.test("saved local diffs and previews remain available offline only to their creator", async () => {
      const created = await newExecution("Private offline snapshot"), id = created.execution.id, head = "c".repeat(40);
      await db.workspaceExecution.update({ where: { id }, data: { status: "review", head, localReview: JSON.stringify([
        { path: "src/config.ts", before: null, after: "export const locale = 'zh-CN';" },
        { path: "old.txt", before: "removed", after: null },
      ]) } });
      await db.localRunner.update({ where: { id: runner.runnerId }, data: { lastSeenAt: new Date(Date.now() - 120_000) } });
      const detail = await route.GET(request(owner, project.id, undefined, "?run=" + id), context(project.id));
      assert.equal(detail.status, 200);
      const saved = await detail.json() as { head: string; diff: string; changedPaths: string[]; files: { path: string }[] };
      assert.equal(saved.head, head); assert.match(saved.diff, /export const locale/); assert.ok(saved.changedPaths.includes("old.txt"));
      const file = await route.GET(request(owner, project.id, undefined, "?run=" + id + "&file=src%2Fconfig.ts"), context(project.id));
      assert.equal(file.status, 200); assert.deepEqual(await file.json(), { path: "src/config.ts", head, content: "export const locale = 'zh-CN';" });
      assert.equal((await route.GET(request(member, project.id, undefined, "?run=" + id), context(project.id))).status, 404);
      assert.equal((await route.GET(request(member, project.id, undefined, "?run=" + id + "&file=src%2Fconfig.ts"), context(project.id))).status, 404);
      assert.equal((await route.GET(request(outsider, project.id), context(project.id))).status, 404);
      const memberList = await (await route.GET(request(member, project.id), context(project.id))).json() as { executions: { id: string }[]; runners: { id: string }[] };
      assert.ok(!memberList.executions.some(run => run.id === id)); assert.ok(!memberList.runners.some(item => item.id === runner.runnerId));
      const ownerBody = JSON.stringify(await (await route.GET(request(owner, project.id), context(project.id))).json());
      assert.ok(!ownerBody.includes(runner.token)); assert.ok(!ownerBody.includes("tokenHash")); assert.ok(!ownerBody.includes(root));
      await local.authorizeRunner(runner.runnerId, runner.token);
    });

    await t.test("real worker and SDK consume selected skill and write local files through the durable command queue", async () => {
      const marker = "local-skill-" + randomBytes(8).toString("hex"), secret = "do-not-upload-" + randomBytes(8).toString("hex");
      await writeFile(path.join(root, "config.json"), '{"locale":"old"}', "utf8");
      await writeFile(path.join(root, "notes.md"), "# User notes\nPreserve this uncommitted local document.\n", "utf8");
      await writeFile(path.join(root, ".env"), "PRIVATE_KEY=" + secret, "utf8");
      const skillPackage = await packageFor("Immutable local skill");
      const source = await db.workspaceFile.create({ data: { packageId: skillPackage.id, filename: "PLAN.md", version: 2,
        content: "# Local task skill\nUse locale zh-CN; include this skill marker in REPORT.md: " + marker } });
      const created = await newExecution("Apply selected skill to local project", [source.id]), id = created.execution.id;
      const original = await runRow(id), snapshots = JSON.parse(original.skills) as SkillFile[];
      assert.equal(snapshots[0].version, 2); assert.ok(snapshots[0].content.includes(marker));
      await db.workspaceFile.update({ where: { id: source.id }, data: { version: 3, content: "# Replaced source\nThis must not replace the selected immutable skill." } });
      let done = false, pumpFailure: unknown, ordinal = 0, closes = 0;
      const calls = new Map<string, number>();
      const pump = (async () => {
        while (!done) {
          await local.authorizeRunner(runner.runnerId, runner.token);
          const approvals = await local.pendingLocalCommands(project.id, owner.id, [id]);
          for (const pending of approvals.get(id) ?? []) await local.decideLocalCommand(project.id, owner.id, id, pending.id, false);
          const command = await local.claimRunnerCommand(runner.runnerId);
          if (!command) { await pause(10); continue; }
          calls.set(command.id, (calls.get(command.id) ?? 0) + 1);
          if (!openSnapshots.has(command.executionId)) { await filesystem.snapshotWorkspace(root, command.executionId); openSnapshots.add(command.executionId); }
          let result: unknown, error: string | undefined;
          try {
            const input = command.input as { path?: string; paths?: string[]; head?: string; receiptBudget?: number; changes?: ({ path: string; content?: string; delete?: boolean })[] };
            if (command.operation === "list") result = await filesystem.listWorkspace(command.executionId);
            else if (command.operation === "read") result = await filesystem.readWorkspace(command.executionId, input.path!);
            else if (command.operation === "write") result = await filesystem.writeWorkspace(command.executionId, input.head!, input.changes!.map(change => change.delete ? { path: change.path, delete: true as const } : { path: change.path, content: change.content! }), input.receiptBudget);
            else if (command.operation === "inspect") result = await filesystem.inspectWorkspace(command.executionId, input.paths!);
            else throw new Error("Unexpected Runner operation: " + command.operation);
          } catch (cause) { error = cause instanceof Error ? cause.message : "Local filesystem failure."; }
          const completed = await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, { commandId: command.id, leaseOwner: command.leaseOwner, result, error }), context(runner.runnerId));
          assert.equal(completed.status, 200);
          if (command.operation === "write" && !error) {
            const duplicate = await runnerRoute.POST(runnerRequest(runner.runnerId, runner.token, { commandId: command.id, leaseOwner: command.leaseOwner, result }), context(runner.runnerId));
            assert.equal(duplicate.status, 200, "Retrying a successful receipt must be acknowledged without re-executing a write.");
          }
        }
      })().catch(async error => {
        pumpFailure = error;
        await db.workspaceExecution.updateMany({ where: { id, status: "running" }, data: { status: "stopping" } });
      });
      const call = (name: string, args: unknown, step: number) => ({ usage: new Usage(), output: [{ type: "function_call" as const,
        callId: "local-fixture-" + step, name, arguments: JSON.stringify(args), status: "completed" as const }] });
      const model: Model = {
        async getResponse(input) {
          const history = JSON.stringify(input.input), step = ordinal++;
          assert.ok(!history.includes(secret), "Local secret contents must never reach the model."); assert.ok(!history.includes(root), "Absolute local paths must remain local.");
          if (step === 0) return call("list_workspace", { query: "" }, step);
          if (step === 1) return call("read_skill", { id: source.id }, step);
          if (step === 2) { assert.ok(history.includes(marker)); assert.ok(!history.includes("This must not replace")); return call("read_file", { path: "config.json" }, step); }
          if (step === 3) return call("apply_changes", { head: (await filesystem.listWorkspace(id)).head, reason: "Apply immutable local skill",
            changes: [{ path: "config.json", content: '{"locale":"zh-CN"}', delete: false }, { path: "src/config.ts", content: 'export const locale = "zh-CN";', delete: false }, { path: "REPORT.md", content: "# Local result\n" + marker, delete: false }] }, step);
          if (step === 4) return call("verify_workspace", {}, step);
          if (step === 5) return call("run_command", { command: ["node", "--test"] }, step);
          if (step === 6) { assert.match(history, /命令未执行/); return call("review_changes", {}, step); }
          return { usage: new Usage(), output: [{ type: "message" as const, role: "assistant" as const, status: "completed" as const,
            content: [{ type: "output_text" as const, text: "本地文件已保存；静态语法检查通过，命令未执行，请人工验证。" }] }] };
        },
        getStreamedResponse() { throw new Error("unused"); },
      };
      const worker = jobs.executeWorkspaceExecution(id, async () => ({ model, close: async () => { closes++; } }));
      try { await within(worker, "本地工作区脚本执行", 60_000); }
      finally {
        if ((await runRow(id)).status === "running") await store.controlExecution(project.id, owner.id, id, "stop");
        await worker; done = true; await pump;
      }
      if (pumpFailure) throw pumpFailure;
      const saved = await runRow(id), checks = JSON.parse(saved.verification!) as Verification[];
      assert.equal(saved.status, "review", saved.error ?? "Worker did not reach the expected review state."); assert.equal(saved.attempts, 1); assert.equal(closes, 1);
      assert.equal(saved.leaseOwner, null); assert.equal(saved.leaseUntil, null);
      assert.ok(checks.some(check => check.kind === "syntax" && check.status === "passed" && check.head === saved.head));
      assert.ok(checks.some(check => check.kind === "command" && check.status === "unavailable" && /命令未执行/.test(check.output)));
      assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).locale, "zh-CN");
      assert.ok((await readFile(path.join(root, "REPORT.md"), "utf8")).includes(marker));
      assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "# User notes\nPreserve this uncommitted local document.\n");
      assert.equal(await readFile(path.join(root, ".env"), "utf8"), "PRIVATE_KEY=" + secret);
      const snapshot = JSON.parse(saved.localReview!) as { head: string; entries: { path: string; before: string | null; after: string | null }[] };
      assert.equal(snapshot.head, saved.head);
      const review = snapshot.entries;
      assert.equal(review.find(entry => entry.path === "config.json")?.before, '{"locale":"old"}');
      assert.ok(!JSON.stringify(review).includes(secret)); assert.ok(review.some(entry => entry.path === "REPORT.md" && entry.after?.includes(marker)));
      assert.ok(calls.size > 5 && [...calls.values()].every(count => count === 1));
      const eventOwner = await db.workspaceExecution.findUniqueOrThrow({ where: { id }, select: { packageId: true } });
      const progressEvents = await db.researchEvent.findMany({ where: { packageId: eventOwner.packageId, type: { startsWith: "execution_" } }, orderBy: { sequence: "asc" } });
      assert.ok(progressEvents.length > 0);
      assert.ok(progressEvents.some(event => /config\.json|REPORT\.md/.test(event.message)), "Owner timeline must contain the real local file operations.");
      assert.ok(!JSON.stringify(progressEvents).includes(secret));
      assert.ok(!JSON.stringify(progressEvents).includes(root), "Absolute local roots must not enter operation events.");
      const { visibleResearchEvents } = await import("../lib/workspace-agent/event-visibility");
      assert.deepEqual(await visibleResearchEvents(eventOwner.packageId, progressEvents, owner.id), progressEvents);
      assert.deepEqual(await visibleResearchEvents(eventOwner.packageId, progressEvents, member.id), []);
      assert.deepEqual(await visibleResearchEvents(eventOwner.packageId, progressEvents), [], "Research model contexts do not receive private local operation events.");
      const researchRoute = await import("../app/api/research/[id]/route"), streamRoute = await import("../app/api/research/[id]/stream/route");
      const researchRequest = (user: typeof users[number], stream = false, signal?: AbortSignal) => new Request(`http://localhost/api/research/${eventOwner.packageId}${stream ? "/stream" : ""}`, {
        headers: { Cookie: cookieName + "=" + user.token }, signal,
      });
      const ownerResponse = await researchRoute.GET(researchRequest(owner), context(eventOwner.packageId));
      assert.equal(ownerResponse.status, 200);
      assert.ok((await ownerResponse.json()).events.some((event: { type: string }) => event.type === "execution_progress"));
      const memberResponse = await researchRoute.GET(researchRequest(member), context(eventOwner.packageId));
      assert.equal(memberResponse.status, 200);
      assert.ok(!(await memberResponse.json()).events.some((event: { type: string }) => event.type.startsWith("execution_")));
      for (const [user, canSee] of [[owner, true], [member, false]] as const) {
        const controller = new AbortController();
        const response = await streamRoute.GET(researchRequest(user, true, controller.signal), context(eventOwner.packageId));
        const reader = response.body!.getReader();
        try {
          let received = "";
          for (let read = 0; read < 80; read++) {
            const chunk = await within(reader.read(), "private execution SSE", 20_000);
            if (chunk.done) break;
            received += new TextDecoder().decode(chunk.value);
            if (canSee ? received.includes("event: execution_progress") : received.includes(": heartbeat")) break;
          }
          assert.equal(received.includes("event: execution_progress"), canSee, "SSE obeys the same local task privacy as the snapshot API.");
          if (!canSee) assert.ok(!/config\.json|REPORT\.md/.test(received));
        } finally { controller.abort(); await reader.cancel(); }
      }
      const commands = await db.localRunnerCommand.findMany({ where: { executionId: id } });
      assert.ok(commands.length && commands.every(command => command.status === "consumed" && command.input === "{}" && command.result === null), "Completed commands must retain their acknowledgment while dropping transferred contents.");
      const detail = await route.GET(request(owner, project.id, undefined, "?run=" + id), context(project.id));
      assert.equal(detail.status, 200); assert.ok(JSON.stringify(await detail.json()).includes(marker));
    });
  } finally {
    for (const id of openSnapshots) await filesystem.closeWorkspace(id);
    // Project deletion intentionally detaches research packages in the product.
    // Delete our packages first so their executions/events cascade during test cleanup.
    if (projectIds.length) await db.researchPackage.deleteMany({ where: { projectId: { in: projectIds } } });
    if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
    if (users.length) await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await db.$disconnect();
    globalThis.fetch = originalFetch; process.env = previous;
    // This unique directory was created by mkdtemp and verified under tmpdir.
    await rm(root, { recursive: true, force: true });
  }
});
