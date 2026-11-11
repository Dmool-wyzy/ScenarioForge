import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runner, Usage, type Model } from "@openai/agents";
import { initializeDemoRepository, repositorySummary } from "../lib/repository";
import { commitRepositoryFiles } from "../lib/repository-workspace";
import { AgentWorkspace, agentFilePath, prepareAgentWorkspace } from "../lib/workspace-agent/workspace";
import { describeSkill, selectSkillSnapshots, snapshotSkill, type SkillSource } from "../lib/workspace-agent/skills";
import { runWorkspaceAgent } from "../lib/workspace-agent/agent";
import { containerArguments, createVerificationSnapshotDirectory, removeVerificationSnapshotDirectory, syntaxDiagnostic, verifySyntax, writeVerificationFile } from "../lib/workspace-agent/verification";
import { checksAtHead, recordCheck } from "../lib/workspace-agent/checks";
import type { ExecutionProgress, Verification } from "../lib/workspace-agent/types";
import { createProgressReporter, progressCommand, progressPaths } from "../lib/workspace-agent/progress";
import { db } from "../lib/db";
import { controlExecution, executionView } from "../lib/workspace-agent/store";

const actor = { id: "alice", username: "测试成员", owner: false };
const source = (): SkillSource => ({ id: "skill-a", packageId: "research-a", filename: "PLAN.md", version: 2, content: "# 实施指导\n\n生成配置中的 language 字段，使用中文。\n\n> 训练性能待确认。", package: { title: "安全帽项目", researchPlan: null } });
async function fixture(run: () => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-execution-test-")), previous = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  try { await initializeDemoRepository("project"); await run(); }
  finally { if (previous === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT; else process.env.SCENARIOFORGE_GIT_ROOT = previous; await rm(root, { recursive: true, force: true }); }
}

test("selected skill files freeze content, version and provenance without download", () => {
  const original = source(), snapshots = selectSkillSnapshots([original], [original.id]), skill = snapshots[0];
  original.content = "later content"; original.version++;
  assert.equal(skill.version, 2); assert.match(skill.content, /language/); assert.doesNotMatch(JSON.stringify(describeSkill(skill)), /language/);
  assert.notEqual(skill.path, snapshotSkill(original).path);
  assert.notEqual(skill.path, snapshotSkill({ ...source(), id: "another-project-file" }).path);
  assert.throws(() => selectSkillSnapshots([], ["foreign"]), /不属于此项目/);
  assert.throws(() => selectSkillSnapshots([source()], ["skill-a", "skill-a"]), /不同技能/);
  assert.throws(() => selectSkillSnapshots([{ ...source(), content: "x".repeat(60001) }], ["skill-a"]), /60000/);
});

test("real SDK loads skills, writes actual files, fixes failed verification and reviews diff", async () => fixture(async () => {
  const skill = snapshotSkill(source()), baseline = (await repositorySummary("project")).head;
  const prepared = await prepareAgentWorkspace("project", "run-one", actor, [skill], baseline);
  const workspace = new AgentWorkspace("project", prepared.branch, actor);
  const checks: string[] = [], progress: string[] = [], details: ExecutionProgress[] = [];
  let filteredInputs = 0;
  let stage = 0;
  const model: Model = {
    async getResponse(input) {
      const call = (name: string, args: unknown) => ({ usage: new Usage(), output: [{ type: "function_call" as const, callId: `call-${stage}`, name, arguments: JSON.stringify(args), status: "completed" as const }] });
      const current = stage++;
      if (current === 0) { assert.match(JSON.stringify(input.input), /PLAN.md/); return call("list_workspace", { query: "" }); }
      if (current === 1) return call("read_skill", { id: skill.id });
      if (current === 2) { assert.match(JSON.stringify(input.input), /训练性能待确认/); return call("apply_changes", { head: (await workspace.list()).head, reason: "生成配置与源码", changes: [
        { path: "config/settings.json", content: '{"language":', delete: false }, { path: "src/main.ts", content: 'export const language = "zh-CN";\n', delete: false },
      ] }); }
      if (current === 3) return call("verify_workspace", {});
      if (current === 4) { assert.match(JSON.stringify(input.input), /JSON 格式不正确/); return call("read_file", { path: "config/settings.json" }); }
      if (current === 5) return call("apply_changes", { head: (await workspace.list()).head, reason: "修复配置语法", changes: [{ path: "config/settings.json", content: '{"language":"zh-CN"}\n', delete: false }] });
      if (current === 6) return call("verify_workspace", {});
      if (current === 7) return call("review_changes", {});
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "已生成源码和配置，修复 JSON 语法，静态检查通过；未运行程序测试。" }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const result = await runWorkspaceAgent({ model, workspace, request: "根据技能生成所需配置和源码", skills: [skill], baseCommit: baseline,
    runner: new Runner({ tracingDisabled: true, callModelInputFilter: ({ modelData }) => { filteredInputs++; return modelData; } }),
    signal: new AbortController().signal, onProgress: async (message, detail) => { progress.push(message); if (detail) details.push(detail); }, onCheckpoint: async (_head, check) => { if (check) checks.push(check.status); } });
  assert.deepEqual(checks, ["failed", "passed", "passed"]);
  assert.equal(result.verification.status, "passed"); assert.match(result.review.diff, /zh-CN/);
  assert.ok(result.review.changedPaths.includes("src/main.ts")); assert.ok(progress.some(message => message.includes("技能")));
  assert.equal(filteredInputs, stage, "progress must preserve the existing request filter and model turn count");
  assert.equal(details.filter(detail => detail.action === "model_wait" && detail.phase === "waiting").length, stage);
  assert.equal(details.filter(detail => detail.action === "model_wait" && detail.phase === "completed").length, stage);
  assert.ok(details.some(detail => detail.action === "read_skill" && detail.phase === "completed" && detail.skill?.filename === "PLAN.md" && detail.skill.version === 2));
  assert.ok(details.some(detail => detail.action === "read_file" && detail.phase === "completed" && detail.paths?.includes("config/settings.json")));
  assert.ok(progress.some(message => message.includes("新建 src/main.ts")));
  assert.ok(progress.some(message => message.includes("修改 config/settings.json")));
  assert.ok(details.some(detail => detail.action === "verify_workspace" && detail.phase === "completed" && detail.status === "failed"));
  assert.ok(details.some(detail => detail.action === "review_changes" && detail.phase === "completed" && detail.fileCount === result.review.changedPaths.length));
  for (const completed of details.filter(detail => detail.phase === "completed")) {
    assert.ok(typeof completed.durationMs === "number" && completed.durationMs >= 0);
    assert.ok(details.some(started => started.operationId === completed.operationId && ["started", "waiting"].includes(started.phase)));
  }
  assert.doesNotMatch(JSON.stringify({ progress, details }), /训练性能待确认|export const language/);
  assert.equal(JSON.parse((await workspace.read("config/settings.json")).content).language, "zh-CN");
  assert.match((await workspace.read(skill.path)).content, /来源版本：2/);
  assert.equal((await repositorySummary("project")).head, baseline, "shared main must remain unchanged");
  const resumed = await prepareAgentWorkspace("project", "run-one", actor, [skill], baseline);
  assert.equal(resumed.head, result.verification.head, "resume must retain saved commits and skill versions");
}));

test("local progress identifies real operations and unavailable commands without claiming test execution", async () => fixture(async () => {
  const baseline = (await repositorySummary("project")).head;
  const prepared = await prepareAgentWorkspace("project", "local-progress", actor, [], baseline);
  const workspace = Object.assign(new AgentWorkspace("project", prepared.branch, actor), { local: true,
    runCommand: async (head: string, command: string[]): Promise<Verification> => ({ head, kind: "command", command, status: "unavailable", output: "Fixture user declined; command did not run." }) });
  const progress: { message: string; detail?: ExecutionProgress }[] = [];
  let stage = 0;
  const model: Model = {
    async getResponse() {
      const current = stage++;
      const call = (name: string, args: unknown) => ({ usage: new Usage(), output: [{ type: "function_call" as const, callId: `local-progress-${current}`, name, arguments: JSON.stringify(args), status: "completed" as const }] });
      if (current === 0) return call("list_workspace", { query: "" });
      if (current === 1) return call("apply_changes", { head: (await workspace.list()).head, reason: "Create a local progress fixture", changes: [{ path: "src/local.mjs", content: "export const secretFixtureText = 3;\n", delete: false }] });
      if (current === 2) return call("read_file", { path: "src/local.mjs" });
      if (current === 3) return call("run_command", { command: ["node", "--test", "tests/example.test.mjs"] });
      if (current === 4) return call("review_changes", {});
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Files saved; command was not executed." }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  await runWorkspaceAgent({ model, workspace, request: "Show local action progress", skills: [], baseCommit: baseline, signal: new AbortController().signal,
    onProgress: async (message, detail) => { progress.push({ message, detail }); }, onCheckpoint: async () => {} });
  const command = progress.filter(event => event.detail?.action === "run_command");
  assert.equal(command.length, 2);
  assert.equal(command[0].detail?.phase, "waiting"); assert.match(command[0].message, /请求命令审批/);
  assert.deepEqual(command[0].detail?.command, ["node", "--test", "tests/example.test.mjs"]);
  assert.equal(command[1].detail?.status, "unavailable"); assert.match(command[1].message, /未完成验证/);
  assert.ok(progress.some(event => /已读取 src\/local.mjs/.test(event.message)));
  assert.ok(progress.some(event => /新建 src\/local.mjs/.test(event.message)));
  assert.doesNotMatch(JSON.stringify(progress), /Agent 正在处理本地工作区|secretFixtureText|命令验证通过/);
}));

test("progress rejects absolute/private paths and inline command content before recording metadata", () => {
  assert.deepEqual(progressPaths(["src/main.mjs", "/home/user/private.mjs", "C:\\user\\private.mjs", "../secret.mjs", ".env.local", "secrets/key.pem"]), ["src/main.mjs"]);
  assert.deepEqual(progressCommand(["node", "--test", "tests/calc.test.mjs"]), ["node", "--test", "tests/calc.test.mjs"]);
  for (const command of [["node", "-e", "console.log('private-inline-source')"], ["node", "C:\\private\\test.mjs"], ["node", "test.mjs", "--token=private"], ["curl", "https://private.example/key"]]) assert.equal(progressCommand(command), undefined);
});

test("failed operations record their failure and duration without copying error bodies", async () => {
  const events: { message: string; detail?: ExecutionProgress }[] = [];
  const record = createProgressReporter(async (message, detail) => { events.push({ message, detail }); });
  const failure = new Error("private-upstream-body /home/private/workspace source-code");
  await assert.rejects(record({ action: "read_file", message: "正在读取 src/main.mjs", detail: { paths: ["src/main.mjs"] },
    run: async () => { throw failure; }, completed: () => ({ message: "Must never appear" }) }), error => error === failure);
  assert.equal(events.length, 2);
  assert.equal(events[0].detail?.phase, "started"); assert.equal(events[1].detail?.phase, "failed");
  assert.equal(events[0].detail?.operationId, events[1].detail?.operationId);
  assert.ok((events[1].detail?.durationMs ?? -1) >= 0);
  assert.doesNotMatch(JSON.stringify(events), /private-upstream-body|\/home\/private|source-code|Must never appear/);
});

test("stopped tasks, stale heads, private paths and skill writes cannot change the branch", async () => fixture(async () => {
  const prepared = await prepareAgentWorkspace("project", "run-guard", actor, []);
  const workspace = new AgentWorkspace("project", prepared.branch, actor);
  await workspace.write(prepared.head, [{ path: "src/file.txt", content: "first" }], "首次写入");
  await assert.rejects(workspace.write(prepared.head, [{ path: "src/file.txt", content: "stale" }], "过期修改"), /分支已有新提交/);
  for (const filename of ["../secret", ".git/config", ".env.local", "nested/id_ed25519", ".scenarioforge/skills/anything.md"]) assert.throws(() => agentFilePath(filename));
  assert.equal(agentFilePath(".env.example"), ".env.example");
  const stopped = new AgentWorkspace("project", prepared.branch, actor, async () => { throw new Error("stopped"); });
  await assert.rejects(stopped.write((await workspace.list()).head, [{ path: "src/file.txt", content: "late" }], "停止后的写入"), /stopped/);
  assert.equal((await workspace.read("src/file.txt")).content, "first");
  await commitRepositoryFiles("project", actor, prepared.branch, (await workspace.list()).head, "人工提交环境文件与特殊文件名", [
    { path: ".env.local", content: "PRIVATE_VALUE=must-never-appear-in-agent-diff" },
    { path: "[.]env.local", content: "ordinary project text" },
  ]);
  await assert.rejects(workspace.read(".env.local"), /不属于 Agent/);
  const review = await workspace.diff(prepared.baseCommit);
  assert.ok(!review.changedPaths.includes(".env.local"));
  assert.ok(review.changedPaths.includes("[.]env.local"));
  assert.doesNotMatch(review.diff, /must-never-appear/);
  assert.match(review.diff, /ordinary project text/);
}));

test("verification distinguishes syntax checks from commands and constrains container execution", () => {
  assert.equal(syntaxDiagnostic("src/main.ts", "export const n: number = 1;"), null);
  assert.equal(syntaxDiagnostic("types.d.ts", "declare const n: number;"), null);
  assert.match(syntaxDiagnostic("src/bad.ts", "export const n = ;") ?? "", /bad.ts/);
  assert.match(syntaxDiagnostic("config.json", "{") ?? "", /JSON/);
  const args = containerArguments("sf-test", path.join(tmpdir(), "isolated"), ["node", "--test", "test.mjs"]);
  for (const flag of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) assert.ok(args.includes(flag));
  assert.ok(args.some(arg => arg.includes("readonly"))); assert.deepEqual(args.slice(-3), ["node", "--test", "test.mjs"]);
  assert.ok(!args.some(arg => arg.includes("OPENAI") || arg.includes("DATABASE_URL")));
  assert.throws(() => containerArguments("sf-test", path.join(tmpdir(), "comma,root"), ["node"]), /挂载目录配置无效/);
});

test("a text-only workspace is marked as unverified rather than reporting tests passed", async () => fixture(async () => {
  const prepared = await prepareAgentWorkspace("project", "run-docs", actor, []);
  const verification = await verifySyntax(new AgentWorkspace("project", prepared.branch, actor));
  assert.equal(verification.status, "unavailable"); assert.equal(verification.kind, "syntax");
}));

test("restored branches cannot reuse checks from an earlier commit or hide failed commands", () => {
  const oldHead = "a".repeat(40), head = "b".repeat(40);
  const command: Verification = { head: oldHead, kind: "command", command: ["node", "--test"], status: "passed", output: "old success" };
  const syntax: Verification = { head, kind: "syntax", status: "passed", output: "syntax only" };
  assert.deepEqual(checksAtHead(JSON.stringify([command]), head), []);
  assert.deepEqual(recordCheck(JSON.stringify([command]), head, syntax), [syntax]);
  assert.throws(() => recordCheck(null, head, command), /不属于当前提交/);
  let checks: Verification[] = [{ ...command, head, status: "failed" }];
  for (let index = 0; index < 12; index++) checks = recordCheck(JSON.stringify(checks), head, { ...command, head, command: ["node", `test-${index}.mjs`] });
  checks = recordCheck(JSON.stringify(checks), head, syntax);
  assert.equal(checks[0].status, "failed", "later checks must not evict a failed command");
  const fixed = recordCheck(JSON.stringify(checks), head, { ...command, head });
  assert.ok(fixed.every(check => check.status === "passed"));
  assert.deepEqual(recordCheck(JSON.stringify(fixed), "c".repeat(40)), [], "a write invalidates verification");
});

test("verification exports remain readable to the container inside a private temporary parent", async context => {
  const temporary = await mkdtemp(path.join(tmpdir(), "sf-export-test-"));
  const directory = path.join(temporary, "workspace");
  try {
    await mkdir(directory, { mode: 0o755 });
    await writeVerificationFile(directory, "nested/tests/example.mjs", "export const value = 1;\n");
    assert.equal(await readFile(path.join(directory, "nested/tests/example.mjs"), "utf8"), "export const value = 1;\n");
    await assert.rejects(writeVerificationFile(directory, "../outside.mjs", "invalid"), /文件路径无效/);
    if (process.platform === "win32") context.diagnostic("POSIX mode validation requires the Linux acceptance environment.");
    else {
      assert.equal((await stat(temporary)).mode & 0o077, 0, "temporary parent must stay private");
      for (const name of ["nested", "nested/tests"]) assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o755);
      assert.equal((await stat(path.join(directory, "nested/tests/example.mjs"))).mode & 0o777, 0o644);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("configured Docker-visible export roots are absolute, private, link-free and safely cleaned", async context => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "sf-export-root-test-"));
  const previousRoot = process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT;
  const configured = path.join(fixtureRoot, "private", "exports");
  const outside = path.join(fixtureRoot, "outside");
  const shortcut = path.join(fixtureRoot, "shortcut");
  await mkdir(outside);
  try {
    for (const unsafe of ["relative/export", path.join(fixtureRoot, "comma,root"), `${fixtureRoot}\nroot`, `${fixtureRoot}\0root`, `${fixtureRoot}${path.sep}escape${path.sep}..${path.sep}root`]) {
      await assert.rejects(createVerificationSnapshotDirectory(unsafe), /导出目录配置无效/);
    }
    if (process.platform !== "win32") {
      await chmod(outside, 0o755);
      await symlink(outside, shortcut, "dir");
      await assert.rejects(createVerificationSnapshotDirectory(path.join(shortcut, "exports")), /不能包含链接/);
      await assert.rejects(createVerificationSnapshotDirectory(outside), /0700 私有权限/);
    } else context.diagnostic("Symlink rejection requires the Linux acceptance environment.");

    process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT = configured;
    const snapshot = await createVerificationSnapshotDirectory();
    const resolvedRoot = path.resolve(configured);
    assert.equal(path.dirname(snapshot), resolvedRoot);
    if (process.platform !== "win32") {
      assert.equal((await stat(resolvedRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(snapshot)).mode & 0o777, 0o700);
    }
    assert.ok(!snapshot.includes(","));
    const workspace = path.join(snapshot, "workspace");
    await mkdir(workspace, { mode: 0o755 });
    await writeVerificationFile(workspace, "nested/calc.mjs", "export const answer = 42;\n");
    assert.equal((await readFile(path.join(workspace, "nested/calc.mjs"), "utf8")), "export const answer = 42;\n");
    await assert.rejects(removeVerificationSnapshotDirectory(path.join(fixtureRoot, "outside", "anything"), resolvedRoot), /拒绝清理/);
    await removeVerificationSnapshotDirectory(snapshot, resolvedRoot);
    assert.equal(await stat(snapshot).then(() => true, () => false), false);
    assert.equal((await stat(resolvedRoot)).isDirectory(), true, "cleanup preserves the configured root");

    delete process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT;
    const defaultSnapshot = await createVerificationSnapshotDirectory(undefined);
    assert.equal(path.dirname(defaultSnapshot), path.resolve(tmpdir()), "local default keeps using the OS temporary directory");
    await removeVerificationSnapshotDirectory(defaultSnapshot, path.resolve(tmpdir()));
    assert.equal(await stat(defaultSnapshot).then(() => true, () => false), false);
  } finally {
    if (previousRoot === undefined) delete process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT;
    else process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT = previousRoot;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("stop/resume enforces ownership, attempt limits and retains immutable execution input", async () => {
  const originals = { transaction: db.$transaction, runFind: db.workspaceExecution.findFirst, runUpdate: db.workspaceExecution.updateMany, runCount: db.workspaceExecution.count, member: db.projectMember.findUnique };
  const run = { id: "run", packageId: "package", createdBy: "alice", target: "github", runnerId: null, workspaceDirectory: null, localReview: null, status: "running", attempts: 1, request: "original request", skills: "[]", branch: "work/alice/agent-run", head: "h", baseCommit: "b", modelConfigEncrypted: "never-public", verification: null, summary: null, error: null, createdAt: new Date(), updatedAt: new Date(), leaseOwner: "owner", leaseUntil: new Date() };
  const events: string[] = [];
  try {
    const tx = { ...db, $queryRaw: async () => [],
      researchPackage: { findFirst: async () => ({ status: "documents_ready", taskState: "idle", pendingMessage: null }), update: async () => ({ eventSequence: 1 }) },
      workspaceFile: { count: async () => 0 }, clarification: { count: async () => 0 },
      researchEvent: { create: async ({ data }: { data: { type: string } }) => { events.push(data.type); } } };
    db.$transaction = (async (callback: unknown) => (callback as (tx: unknown) => Promise<unknown>)(tx)) as typeof db.$transaction;
    db.workspaceExecution.findFirst = (async () => run) as typeof db.workspaceExecution.findFirst;
    db.workspaceExecution.count = (async () => 0) as typeof db.workspaceExecution.count;
    db.workspaceExecution.updateMany = (async ({ data }: { data: { status: string } }) => { run.status = data.status; return { count: 1 }; }) as unknown as typeof db.workspaceExecution.updateMany;
    db.projectMember.findUnique = (async () => ({ role: "member" })) as unknown as typeof db.projectMember.findUnique;
    await assert.rejects(controlExecution("project", "bob", "run", "stop"), /只能控制本人/);
    await controlExecution("project", "alice", "run", "stop"); assert.equal(run.status, "stopping");
    run.status = "stopped";
    await controlExecution("project", "alice", "run", "resume"); assert.equal(run.status, "queued");
    assert.equal(run.request, "original request"); assert.equal(run.branch, "work/alice/agent-run");
    assert.ok(!("modelConfigEncrypted" in executionView(run)));
    run.status = "failed"; run.attempts = 3;
    await assert.rejects(controlExecution("project", "alice", "run", "resume"), /3 次执行上限/);
    assert.deepEqual(events, ["execution_stopped", "execution_queued"]);
  } finally {
    db.$transaction = originals.transaction; db.workspaceExecution.findFirst = originals.runFind; db.workspaceExecution.updateMany = originals.runUpdate;
    db.workspaceExecution.count = originals.runCount; db.projectMember.findUnique = originals.member;
  }
});
