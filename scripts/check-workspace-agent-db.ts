import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Model } from "@openai/agents";
import type { Prisma } from "@prisma/client";
import type { SkillFile, Verification } from "../lib/workspace-agent/types";

// Opt-in only: validate the explicit target before importing application modules.
// This suite uses real MySQL and temporary Git repositories, but a scripted model.
// It does not validate a real model service or Docker, and never runs migrations.
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "请先配置独立测试库 SCENARIOFORGE_TEST_DATABASE_URL；尚未导入或连接数据库。");
assert.ok(process.env.DATABASE_URL === databaseUrl, "DATABASE_URL 必须与显式指定的独立测试库相同；拒绝连接。");
const target = new URL(databaseUrl);
assert.ok(target.protocol === "mysql:", "此验收仅支持显式指定的 MySQL 测试库；拒绝连接。");
assert.ok(/^\/scenarioforge_test_[a-z0-9_]{1,45}$/i.test(target.pathname), "测试库名必须以 scenarioforge_test_ 开头；拒绝连接。");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`验收等待超时：${label}`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("isolated MySQL validates workspace execution persistence and concurrency with a scripted model", { timeout: 180_000 }, async t => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(tmpdir(), "sf-execution-db-test-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(async () => {
    globalThis.fetch = originalFetch; process.env = previous;
    // root came directly from mkdtemp above, and was checked to be below tmpdir.
    await rm(root, { recursive: true, force: true });
  });
  process.env.SCENARIOFORGE_ENV_FILE = "";
  process.env.SCENARIOFORGE_TASK_SCHEDULER = "off";
  process.env.SCENARIOFORGE_PUBLIC_ORIGIN = "http://localhost";
  process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
  process.env.RAG_ENABLED = "false";
  // A forgotten runtime injection must fail locally rather than call a provider.
  globalThis.fetch = async () => { throw new Error("数据库验收禁止 HTTP 请求；所有模型必须使用本地脚本替身。"); };
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  const [{ db }, { Usage }, store, jobs, repository, workspace, route] = await Promise.all([
    import("../lib/db"), import("@openai/agents"), import("../lib/workspace-agent/store"), import("../lib/workspace-agent/jobs"),
    import("../lib/repository"), import("../lib/workspace-agent/workspace"), import("../app/api/projects/[id]/executions/route"),
  ]);
  const users: { id: string; token: string; username: string }[] = [], projectIds: string[] = [];
  const stamp = randomBytes(5).toString("hex");
  const reply = (text = "脚本模型执行完成；只做静态语法验证，未运行容器测试。") => ({ usage: new Usage(), output: [{ type: "message" as const, role: "assistant" as const,
    status: "completed" as const, content: [{ type: "output_text" as const, text }] }] });
  const call = (name: string, args: unknown, ordinal: number) => ({ usage: new Usage(), output: [{ type: "function_call" as const,
    callId: `fixture-${ordinal}`, name, arguments: JSON.stringify(args), status: "completed" as const }] });
  const finalModel = (): Model => ({ async getResponse() { return reply(); }, getStreamedResponse() { throw new Error("unused"); } });
  const cookieName = process.env.NODE_ENV === "production" ? "__Host-scenarioforge_session" : "scenarioforge_session";
  const request = (user: typeof users[number] | null, projectId: string, action?: unknown, suffix = "") => {
    const headers = new Headers();
    if (user) headers.set("Cookie", `${cookieName}=${user.token}`);
    if (action !== undefined) { headers.set("Origin", "http://localhost"); headers.set("Content-Type", "application/json"); }
    return new Request(`http://localhost/api/projects/${projectId}/executions${suffix}`, { headers, method: action === undefined ? "GET" : "POST",
      ...(action === undefined ? {} : { body: JSON.stringify(action) }) });
  };
  try {
    for (const role of ["owner", "member", "outsider"]) {
      const user = await db.user.create({ data: { username: `wa_${stamp}_${role}`, passwordHash: "test-only-no-password" } });
      const token = randomBytes(32).toString("base64url");
      users.push({ ...user, token });
      await db.authSession.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 600_000) } });
    }
    const [owner, member, outsider] = users;
    const project = await db.project.create({ data: { name: `Workspace acceptance ${stamp}`, inviteCode: randomBytes(3).toString("hex").toUpperCase(), repositoryEnabled: true,
      members: { create: [{ userId: owner.id, role: "owner" }, { userId: member.id, role: "member" }] } } });
    projectIds.push(project.id);
    const otherProject = await db.project.create({ data: { name: `Workspace foreign ${stamp}`, inviteCode: randomBytes(3).toString("hex").toUpperCase(),
      members: { create: { userId: outsider.id, role: "owner" } } } });
    projectIds.push(otherProject.id);
    await repository.initializeDemoRepository(project.id);
    const baseline = (await repository.repositorySummary(project.id)).head;
    const actor = { id: owner.id, username: owner.username, owner: false };
    const packageFor = (title: string, projectId = project.id) => db.researchPackage.create({ data: { projectId, title: `${stamp} ${title}`, goal: "验收数据", status: "replied" } });
    const skillPackage = await packageFor("Skills"), foreignPackage = await packageFor("Foreign skills", otherProject.id);
    const skill = await db.workspaceFile.create({ data: { packageId: skillPackage.id, filename: "PLAN.md", version: 2, content: "# 项目技能\n\n配置 language 应为 zh-CN；研究假设仍需确认。" } });
    const foreign = await db.workspaceFile.create({ data: { packageId: foreignPackage.id, filename: "PLAN.md", content: "Foreign private skill" } });
    const newExecution = async (label: string, skillIds: string[] = [], userId = owner.id) => {
      const pkg = await packageFor(label);
      return store.createExecution(project.id, userId, { packageId: pkg.id, request: `执行验收：${label}`, skillIds });
    };
    const runRow = (id: string) => db.workspaceExecution.findUniqueOrThrow({ where: { id } });
    const viewFor = (branch: string, user = owner) => new workspace.AgentWorkspace(project.id, branch, { id: user.id, username: user.username, owner: false });

    await t.test("project permissions and immutable skill snapshots are enforced without downloading", async () => {
      const context = { params: Promise.resolve({ id: project.id }) };
      assert.equal((await route.GET(request(null, project.id), context)).status, 401);
      assert.equal((await route.GET(request(outsider, project.id), context)).status, 404);
      assert.equal((await route.POST(request(outsider, project.id, { action: "start", request: "越权", skillIds: [] }), context)).status, 404);
      await assert.rejects(store.createExecution(project.id, owner.id, { packageId: skillPackage.id, request: "不得读取外项目技能", skillIds: [foreign.id] }), /不属于此项目/);
      await assert.rejects(store.createExecution(project.id, owner.id, { packageId: foreignPackage.id, request: "不得使用外项目对话", skillIds: [] }), /不属于此项目/);
      const created = await newExecution("Snapshot", [skill.id]);
      const original = await runRow(created.execution.id);
      assert.equal((JSON.parse(original.skills) as SkillFile[])[0].version, 2);
      await db.workspaceFile.update({ where: { id: skill.id }, data: { version: 3, content: "New source content must not change the original task." } });
      await assert.rejects(store.controlExecution(project.id, member.id, original.id, "stop"), /只能控制本人/);
      await store.controlExecution(project.id, owner.id, original.id, "stop");
      assert.equal((await runRow(original.id)).status, "stopped");
      await store.controlExecution(project.id, owner.id, original.id, "resume");
      const resumed = await runRow(original.id);
      for (const key of ["request", "skills", "branch", "baseCommit", "modelConfigEncrypted"] as const) assert.equal(resumed[key], original[key]);
      assert.equal(resumed.status, "queued");
      assert.equal(resumed.attempts, 0);
      const response = await route.GET(request(member, project.id), context);
      assert.equal(response.status, 200);
      const body = JSON.stringify(await response.json());
      assert.ok(!body.includes("modelConfigEncrypted"));
      assert.ok(!body.includes("New source content must not change"));
      assert.equal((await route.POST(request(outsider, otherProject.id, { action: "stop", executionId: original.id }), { params: Promise.resolve({ id: otherProject.id }) })).status, 404);
      await store.controlExecution(project.id, owner.id, original.id, "stop");
    });

    await t.test("concurrent starts and resumes admit only one active task per conversation", async () => {
      const pkg = await packageFor("Contended starts");
      // Observe transaction arrival only; SQL and application callbacks stay real.
      // Holding the package row lets each request finish Git reads before both contend.
      const originalTransaction = db.$transaction;
      const packageLocked = deferred<void>(), releasePackage = deferred<void>();
      const reached: ReturnType<typeof deferred<void>>[] = [deferred<void>(), deferred<void>()];
      let arrivals = 0;
      const blocker = originalTransaction.call(db, async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM ResearchPackage WHERE id = ${pkg.id} FOR UPDATE`;
        packageLocked.resolve(); await releasePackage.promise;
      }, { timeout: 30_000 });
      const observed: Promise<PromiseSettledResult<Awaited<ReturnType<typeof store.createExecution>>>>[] = [];
      try {
        await within(packageLocked.promise, "取得对话行锁");
        db.$transaction = ((callback: unknown, options: unknown) => {
          const result = originalTransaction.call(db, callback as never, options as never);
          reached[arrivals++]?.resolve();
          return result;
        }) as typeof db.$transaction;
        for (let index = 0; index < 2; index++) {
          const pending = store.createExecution(project.id, owner.id, { packageId: pkg.id, request: "Concurrent start", skillIds: [] });
          const settled = pending.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
          observed.push(settled);
          await within(Promise.race([reached[index].promise, settled.then(() => { throw new Error("请求在数据库行锁释放前提前结束。"); })]), "启动请求进入真实事务");
        }
      } finally {
        db.$transaction = originalTransaction;
        releasePackage.resolve();
        try { await blocker; } finally { await Promise.all(observed); }
      }
      const starts = await Promise.all(observed);
      assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
      const rejected = starts.find(result => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && /已有执行任务/.test(String(rejected.reason)));
      assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id, status: { in: ["queued", "running", "stopping"] } } }), 1);
      const first = await db.workspaceExecution.findFirstOrThrow({ where: { packageId: pkg.id } });
      await store.controlExecution(project.id, owner.id, first.id, "stop");
      const second = await store.createExecution(project.id, owner.id, { packageId: pkg.id, request: "Second stopped task", skillIds: [] });
      await store.controlExecution(project.id, owner.id, second.execution.id, "stop");
      const resumes = await Promise.allSettled([first.id, second.execution.id].map(id => store.controlExecution(project.id, owner.id, id, "resume")));
      assert.equal(resumes.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id, status: { in: ["queued", "running", "stopping"] } } }), 1);
      const active = await db.workspaceExecution.findFirstOrThrow({ where: { packageId: pkg.id, status: "queued" } });
      await store.controlExecution(project.id, owner.id, active.id, "stop");
    });

    await t.test("the actual worker persists SDK tool execution, a syntax failure, repair and final checks", async () => {
      const created = await newExecution("Worker repair", [skill.id]), id = created.execution.id;
      const work = viewFor(created.execution.branch!);
      let step = 0, closes = 0;
      const model: Model = { async getResponse(input) {
        const ordinal = step++;
        if (ordinal === 0) return call("list_workspace", { query: "" }, ordinal);
        if (ordinal === 1) return call("read_skill", { id: skill.id }, ordinal);
        if (ordinal === 2) { assert.match(JSON.stringify(input.input), /New source content/); return call("apply_changes", { head: (await work.list()).head,
          reason: "创建验收源码和错误配置", changes: [{ path: "src/main.ts", content: 'export const language = "zh-CN";', delete: false }, { path: "config/settings.json", content: '{"language":', delete: false }] }, ordinal); }
        if (ordinal === 3) return call("verify_workspace", {}, ordinal);
        if (ordinal === 4) { assert.match(JSON.stringify(input.input), /JSON 格式不正确/); return call("read_file", { path: "config/settings.json" }, ordinal); }
        if (ordinal === 5) return call("apply_changes", { head: (await work.list()).head, reason: "修复配置语法", changes: [{ path: "config/settings.json", content: '{"language":"zh-CN"}', delete: false }] }, ordinal);
        if (ordinal === 6) return call("verify_workspace", {}, ordinal);
        if (ordinal === 7) return call("review_changes", {}, ordinal);
        return reply();
      }, getStreamedResponse() { throw new Error("unused"); } };
      await jobs.executeWorkspaceExecution(id, async () => ({ model, close: async () => { closes++; } }));
      const saved = await runRow(id), checks = JSON.parse(saved.verification!) as Verification[];
      assert.equal(saved.status, "completed"); assert.equal(saved.attempts, 1); assert.equal(closes, 1);
      assert.equal(saved.leaseOwner, null); assert.equal(saved.leaseUntil, null);
      assert.ok(checks.length && checks.every(check => check.head === saved.head && check.status === "passed"));
      const events = await db.researchEvent.findMany({ where: { packageId: created.packageId }, orderBy: { sequence: "asc" } });
      assert.ok(events.some(event => event.type === "execution_checkpoint" && event.payload?.includes('"failed"')));
      assert.ok(events.some(event => event.type === "execution_completed"));
      assert.equal(new Set(events.map(event => event.sequence)).size, events.length);
      assert.equal(JSON.parse((await work.read("config/settings.json")).content).language, "zh-CN");
      assert.equal((await repository.repositorySummary(project.id)).head, baseline);
    });

    await t.test("stopping a running worker preserves commits and resume keeps its original request", async () => {
      const created = await newExecution("Stop running"), id = created.execution.id, work = viewFor(created.execution.branch!);
      const paused = deferred<void>(), release = deferred<void>();
      let step = 0;
      const model: Model = { async getResponse() {
        const ordinal = step++;
        if (ordinal === 0) return call("apply_changes", { head: (await work.list()).head, reason: "停止前保存文件", changes: [{ path: "src/preserved.ts", content: "export const preserved = true;", delete: false }] }, ordinal);
        paused.resolve(); await release.promise; return reply("停止之后不可覆盖结果");
      }, getStreamedResponse() { throw new Error("unused"); } };
      const execution = jobs.executeWorkspaceExecution(id, async () => ({ model }));
      try {
        await within(paused.promise, "等待文件已提交");
        await store.controlExecution(project.id, owner.id, id, "stop");
      } finally { release.resolve(); await execution; }
      const stopped = await runRow(id);
      assert.equal(stopped.status, "stopped"); assert.equal((await work.read("src/preserved.ts")).content, "export const preserved = true;");
      await store.controlExecution(project.id, owner.id, id, "resume");
      await jobs.executeWorkspaceExecution(id, async () => ({ model: finalModel() }));
      const resumed = await runRow(id);
      assert.equal(resumed.attempts, 2); assert.equal(resumed.request, stopped.request); assert.equal(resumed.skills, stopped.skills);
      assert.equal(resumed.branch, stopped.branch); assert.equal(resumed.head, stopped.head); assert.equal(resumed.status, "completed");
    });

    await t.test("a terminated worker process resumes from its durable Git checkpoint in a new process", async () => {
      const created = await newExecution("Process restart", [skill.id]), id = created.execution.id;
      const original = await runRow(id), work = viewFor(created.execution.branch!);
      const marker = `SCENARIOFORGE_WORKER_CHECKPOINT:${randomBytes(12).toString("hex")}`;
      const ready = deferred<void>();
      // Only this test's database and repository are inherited. Application/model
      // credentials from the shell are excluded from the child environment.
      const childEnv: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "test" };
      for (const key of ["PATH", "SystemRoot", "ProgramData", "TEMP", "TMP", "NODE_ENV"]) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
      Object.assign(childEnv, { DATABASE_URL: databaseUrl, SCENARIOFORGE_TEST_DATABASE_URL: databaseUrl,
        SCENARIOFORGE_GIT_ROOT: root, SCENARIOFORGE_ENV_FILE: "", SCENARIOFORGE_TASK_SCHEDULER: "off", RAG_ENABLED: "false" });
      const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", path.resolve("scripts/fixtures/workspace-execution-worker.ts"), id, marker], {
        cwd: process.cwd(), env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", errors = "", spawnError: Error | undefined;
      child.once("error", error => { spawnError = error; });
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-4000);
        if (output.includes(marker)) ready.resolve();
      });
      child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf8")).slice(-4000); });
      const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); });
      try {
        await within(Promise.race([ready.promise, exited.then(() => {
          const detail = (spawnError?.message ?? errors).split(databaseUrl!).join("[test database]");
          throw new Error(`测试子进程未到达持久化检查点：${detail}`);
        })]), "等待子进程已保存文件和检查点");
        // SIGKILL prevents graceful finally/lease release: this is a real crash,
        // unlike the same-process lease takeover tested separately below.
        assert.equal(child.kill("SIGKILL"), true);
        await within(exited, "等待自己创建的 worker 退出");
        const crashed = await runRow(id), file = await work.read("src/restarted.ts");
        assert.equal(crashed.status, "running"); assert.equal(crashed.attempts, 1);
        assert.ok(crashed.leaseOwner); assert.equal(crashed.head, file.head);
        assert.equal(file.content, "export const recoveredAfterRestart = true;");
        assert.equal(crashed.request, original.request); assert.equal(crashed.skills, original.skills);
        assert.ok(await db.researchEvent.count({ where: { packageId: created.packageId, type: "execution_checkpoint" } }));
        await db.workspaceExecution.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
        // The parent process has never owned this task; it must claim its expired
        // lease and reconstruct everything from the database and task branch.
        await jobs.executeWorkspaceExecution(id, async () => ({ model: finalModel() }));
        const recovered = await runRow(id);
        assert.equal(recovered.status, "completed"); assert.equal(recovered.attempts, 2);
        assert.equal(recovered.branch, crashed.branch); assert.equal(recovered.head, crashed.head);
        assert.equal(recovered.request, original.request); assert.equal(recovered.skills, original.skills);
        assert.equal(recovered.leaseOwner, null); assert.equal(recovered.leaseUntil, null);
        assert.equal((await work.read("src/restarted.ts")).content, file.content);
        const frozen = JSON.parse(original.skills) as SkillFile[];
        assert.ok((await work.read(frozen[0].path)).content.includes(`来源版本：${frozen[0].version}`));
        assert.equal((await repository.repositorySummary(project.id)).head, baseline);
      } finally {
        // Never leave a child with a live heartbeat, even when an assertion fails.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await within(exited, "清理本测试 worker 进程");
      }
    });

    await t.test("resuming a manually changed branch invalidates successful checks from the old commit", async () => {
      const created = await newExecution("Invalidate verification"), id = created.execution.id;
      const prepared = await workspace.prepareAgentWorkspace(project.id, id, actor, [], baseline);
      const work = viewFor(prepared.branch);
      const old = await work.write(prepared.head, [{ path: "src/changed.ts", content: "export const value = 1;" }], "旧版本");
      const check: Verification = { head: old.commit, kind: "command", command: ["node", "--test"], status: "passed", output: "old commit only" };
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", head: old.commit, verification: JSON.stringify([check]), attempts: 1 } });
      const updated = await work.write(old.commit, [{ path: "src/changed.ts", content: "export const value = 2;" }], "停止期间人工修改");
      await store.controlExecution(project.id, owner.id, id, "resume");
      await jobs.executeWorkspaceExecution(id, async () => ({ model: finalModel() }));
      const saved = await runRow(id), checks = JSON.parse(saved.verification!) as Verification[];
      assert.equal(saved.head, updated.commit); assert.ok(checks.length);
      assert.ok(checks.every(item => item.head === updated.commit));
      assert.ok(!checks.some(item => item.kind === "command"), "new commit must not inherit the old passing test");
    });

    await t.test("an expired lease is reclaimed and a late old worker cannot replace new results", async () => {
      const created = await newExecution("Lease takeover"), id = created.execution.id, work = viewFor(created.execution.branch!);
      const started = deferred<void>(), release = deferred<void>();
      const delayed: Model = { async getResponse() { started.resolve(); await release.promise;
        return call("apply_changes", { head: (await work.list()).head, reason: "不得写入的迟到修改", changes: [{ path: "late.ts", content: "export const late = true;", delete: false }] }, 0);
      }, getStreamedResponse() { throw new Error("unused"); } };
      const first = jobs.executeWorkspaceExecution(id, async () => ({ model: delayed }));
      let replacement: Awaited<ReturnType<typeof runRow>> | undefined;
      try {
        await within(started.promise, "旧 worker 已进入模型回合");
        await db.workspaceExecution.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
        await jobs.executeWorkspaceExecution(id, async () => ({ model: finalModel() }));
        replacement = await runRow(id);
        assert.equal(replacement.attempts, 2); assert.equal(replacement.status, "review");
      } finally { release.resolve(); await first; }
      const final = await runRow(id);
      assert.equal(final.head, replacement?.head); assert.equal(final.status, replacement?.status);
      assert.equal(final.summary, replacement?.summary); assert.equal(final.verification, replacement?.verification);
      assert.equal(final.leaseOwner, null);
      assert.ok(!(await work.list()).files.some(item => item.path === "late.ts"));
    });

    await t.test("revoked membership blocks subsequent writes and attempts cannot exceed the configured limit", async () => {
      const created = await newExecution("Revoke membership", [], member.id), id = created.execution.id, work = viewFor(created.execution.branch!, member);
      const started = deferred<void>(), release = deferred<void>();
      const model: Model = { async getResponse() { started.resolve(); await release.promise;
        return call("apply_changes", { head: baseline, reason: "无权限后不能写入", changes: [{ path: "forbidden.ts", content: "export const forbidden = true;", delete: false }] }, 0);
      }, getStreamedResponse() { throw new Error("unused"); } };
      const execution = jobs.executeWorkspaceExecution(id, async () => ({ model }));
      try {
        await within(started.promise, "等待成员任务开始");
        await db.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: member.id } } });
      } finally { release.resolve(); await execution; }
      assert.equal((await runRow(id)).status, "failed");
      assert.ok(!(await work.list()).files.some(item => item.path === "forbidden.ts"));
      await db.projectMember.create({ data: { projectId: project.id, userId: member.id, role: "member" } });
      await db.workspaceExecution.update({ where: { id }, data: { status: "stopped", attempts: 3 } });
      await assert.rejects(store.controlExecution(project.id, owner.id, id, "resume"), /3 次执行上限/);
      await db.workspaceExecution.update({ where: { id }, data: { status: "queued" } });
      let resolved = false;
      await jobs.executeWorkspaceExecution(id, async () => { resolved = true; return { model: finalModel() }; });
      assert.equal(resolved, false); assert.equal((await runRow(id)).attempts, 3);
    });
  } finally {
    try {
      if (projectIds.length) {
        await db.researchPackage.deleteMany({ where: { projectId: { in: projectIds } } });
        await db.project.deleteMany({ where: { id: { in: projectIds } } });
      }
      if (users.length) await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    } finally { await db.$disconnect(); }
  }
});
