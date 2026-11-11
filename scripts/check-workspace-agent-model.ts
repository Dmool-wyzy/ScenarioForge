import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Verification } from "../lib/workspace-agent/types";

// Validate explicit targets before importing application modules or contacting services.
assert.ok(process.env.SCENARIOFORGE_TEST_MODEL === "1", "真实模型验收须显式设置 SCENARIOFORGE_TEST_MODEL=1；尚未连接任何服务。");
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "须指定独立测试库 SCENARIOFORGE_TEST_DATABASE_URL；尚未连接数据库。");
assert.ok(process.env.DATABASE_URL === databaseUrl, "DATABASE_URL 必须与显式指定的独立测试库相同；拒绝连接。");
const databaseTarget = new URL(databaseUrl);
assert.ok(databaseTarget.protocol === "mysql:", "此验收只允许显式指定的 MySQL 测试库。");
assert.ok(/^\/scenarioforge_test_[a-z0-9_]{1,45}$/i.test(databaseTarget.pathname), "测试库名必须以 scenarioforge_test_ 开头；拒绝连接。");
assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, "真实模型验收只允许本机 Docker，不允许外部 Docker endpoint。");

const command = ["node", "--test", "tests/calc.test.mjs"];
const brokenSource = "export function add(a, b) { return a - b; }\n";
const trustedTests = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { add } from "../src/calc.mjs";',
  'test("trusted addition: positive", () => assert.equal(add(2, 3), 5));',
  'test("trusted addition: negative", () => assert.equal(add(-7, -2), -9));',
  'test("trusted addition: zero", () => assert.equal(add(0, 0), 0));',
  'test("trusted addition: decimal", () => assert.equal(add(0.5, 0.25), 0.75));',
  'test("trusted addition: mixed signs", () => assert.equal(add(-2, 5), 3));',
  "",
].join("\n");

function payload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function assertPassedCommand(check: Verification, head: string) {
  assert.equal(check.kind, "command", "必须提供真实命令验证证据。");
  assert.equal(check.status, "passed", "真实容器测试必须通过，unavailable 不算通过。");
  assert.equal(check.head, head, "命令验证必须属于最终提交。");
  assert.deepEqual(check.command, command, "必须运行完整的可信测试文件。");
  for (const name of ["positive", "negative", "zero", "decimal", "mixed signs"]) {
    assert.ok(check.output.includes(`trusted addition: ${name}`), "命令输出须包含全部可信测试名称。");
  }
  assert.match(check.output, /\btests\s+5\b/, "必须实际运行五个测试。");
  assert.match(check.output, /\bpass\s+5\b/, "五个测试必须全部通过。");
  assert.match(check.output, /\bfail\s+0\b/, "不能包含失败测试。");
  assert.match(check.output, /\bskipped\s+0\b/, "不能跳过测试。");
}

test("real model reads a frozen skill, repairs a failing workspace and passes trusted Docker tests", { timeout: 650000 }, async context => {
  const previous = { ...process.env };
  const secrets = Object.entries(previous).filter(([name, value]) => value && /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/i.test(name)).map(([, value]) => value!);
  const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text)
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
  const reportPath = process.env.SCENARIOFORGE_MODEL_ACCEPTANCE_REPORT;
  if (reportPath) {
    assert.ok(path.isAbsolute(reportPath), "验收报告须使用父进程指定的绝对路径。");
    const parent = await lstat(path.dirname(reportPath));
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), "验收报告父目录必须为现有普通目录。");
  }
  const root = await mkdtemp(path.join(tmpdir(), "sf-model-acceptance-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()), "只允许使用本次创建的临时 Git 目录。");
  context.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  });
  // Never read a local/production env file, start a scheduler, or use production keys for fixture encryption.
  process.env.SCENARIOFORGE_ENV_FILE = "";
  process.env.SCENARIOFORGE_TASK_SCHEDULER = "off";
  process.env.RAG_ENABLED = "false";
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
  process.env.SCENARIOFORGE_INTERNAL_TOKEN = randomBytes(32).toString("hex");
  const [{ db }, store, jobs, repository, workspaceModule, settingsModule, { getResearchConfig }, { verifyCommand }] = await Promise.all([
    import("../lib/db"), import("../lib/workspace-agent/store"), import("../lib/workspace-agent/jobs"),
    import("../lib/repository"), import("../lib/workspace-agent/workspace"), import("../lib/model-settings"),
    import("../lib/env"), import("../lib/workspace-agent/verification"),
  ]);
  const config = getResearchConfig();
  const settings = settingsModule.modelSettingsSchema.parse({ baseUrl: config.OPENAI_BASE_URL, model: config.SCENARIOFORGE_MODEL,
    apiMode: config.OPENAI_API_MODE, apiKey: config.OPENAI_API_KEY, timeoutSeconds: config.MODEL_TIMEOUT_SECONDS, deepseekSearchEnabled: false });
  assert.ok(settings.apiKey, "父进程必须显式提供本次获准使用的模型配置。");
  const stamp = randomBytes(5).toString("hex"), marker = `SKILL_ACCEPTANCE_${randomBytes(12).toString("hex")}`;
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), passed: false,
    model: { name: settings.model, origin: new URL(settings.baseUrl).origin, apiMode: settings.apiMode },
    command, trustedTests, marker };
  let userId: string | undefined, projectId: string | undefined, runId: string | undefined;
  let work: InstanceType<typeof workspaceModule.AgentWorkspace> | undefined;
  try {
    const user = await db.user.create({ data: { username: `wa_model_${stamp}`, passwordHash: "test-only-no-password" } });
    userId = user.id;
    const project = await db.project.create({ data: { name: `Model acceptance ${stamp}`, inviteCode: randomBytes(3).toString("hex").toUpperCase(),
      repositoryEnabled: true, members: { create: { userId: user.id, role: "owner" } } } });
    projectId = project.id;
    const encrypted = settingsModule.encryptModelSettings(project.id, { ...settings, apiKey: settings.apiKey });
    await db.project.update({ where: { id: project.id }, data: { modelConfigEncrypted: encrypted } });
    await repository.initializeDemoRepository(project.id);
    const baseline = (await repository.repositorySummary(project.id)).head;
    const skillPackage = await db.researchPackage.create({ data: { projectId: project.id, title: "可信加法技能", goal: "一次真实模型验收", status: "replied" } });
    const skill = await db.workspaceFile.create({ data: { packageId: skillPackage.id, filename: "PLAN.md", version: 2, content: [
      "# 加法修复流程", `技能专属验收标记：${marker}`, "",
      "范围：仅修改 src/calc.mjs、新建 docs/REPORT.md；不得修改、删除或跳过 tests/calc.test.mjs 的任何内容。",
      "src/calc.mjs 需导出 add(a, b)，返回两个数字的和，支持正数、负数、零、小数。无需安装任何依赖。",
      "必须先运行 [\"node\",\"--test\",\"tests/calc.test.mjs\"]，观察当前错误实现的真实失败；先失败再修复，不得先改代码。",
      "读取现有源码后修复函数，生成 docs/REPORT.md，逐字包含上述技能专属标记，说明事实、建议与待确认事项。",
      "修改后再运行同一条完整测试命令，五项测试均通过且零跳过。随后检查语法并 review_changes。",
      "报告须如实描述失败与修复后的结果；不得声称已合并、部署或验证任何研究假设。",
    ].join("\n") } });
    const created = await store.createExecution(project.id, user.id, { request: "按本任务唯一选中的 PLAN.md 技能完成加法修复流程。实际运行失败测试后再修复，交付源码与报告，通过完整测试后审查差异。", skillIds: [skill.id] });
    runId = created.execution.id;
    const actor = { id: user.id, username: user.username, owner: false };
    const frozen = await db.workspaceExecution.findUniqueOrThrow({ where: { id: runId } });
    assert.ok(frozen.modelConfigEncrypted === encrypted, "执行任务必须冻结本测试项目的模型配置。");
    assert.ok(frozen.baseCommit === baseline, "执行任务须从独立仓库 main 开始。");
    const prepared = await workspaceModule.prepareAgentWorkspace(project.id, runId, actor, JSON.parse(frozen.skills), baseline);
    work = new workspaceModule.AgentWorkspace(project.id, prepared.branch, actor);
    await work.write(prepared.head, [{ path: "src/calc.mjs", content: brokenSource }, { path: "tests/calc.test.mjs", content: trustedTests }], "预置错误实现和可信验收测试");
    evidence.branch = prepared.branch;
    evidence.baseline = baseline;

    // Exactly one real worker attempt. No injected model, retry, resume, or automatic scheduler.
    await jobs.executeWorkspaceExecution(runId);
    const saved = await db.workspaceExecution.findUniqueOrThrow({ where: { id: runId } });
    const checks = JSON.parse(saved.verification ?? "[]") as Verification[];
    const events = await db.researchEvent.findMany({ where: { packageId: created.packageId }, orderBy: { sequence: "asc" } });
    assert.equal(saved.status, "completed", "模型必须完成实际文件变更与验证；review/failed 不算通过。");
    assert.equal(saved.attempts, 1, "只允许一次真实模型 worker 尝试。");
    assert.equal(saved.leaseOwner, null); assert.equal(saved.leaseUntil, null);
    assert.ok(saved.head, "必须保存最终提交。");
    assert.ok(saved.modelConfigEncrypted === encrypted, "执行结束后冻结的项目模型配置不能改变。");
    assert.equal((await work.list()).head, saved.head);
    const finalCheck = checks.find(check => check.kind === "command" && JSON.stringify(check.command) === JSON.stringify(command));
    assert.ok(finalCheck, "必须保存模型通过 run_command 执行的完整测试结果。");
    assertPassedCommand(finalCheck, saved.head);
    const checkpoints = events.filter(event => event.type === "execution_checkpoint" && payload(event.payload).kind === "command");
    const failed = checkpoints.find(event => payload(event.payload).status === "failed");
    assert.ok(failed, "必须保留模型首次运行真实测试失败的事件。");
    assert.match(failed.message, /trusted addition/);
    assert.match(failed.message, /ERR_ASSERTION|AssertionError/);
    const failedHead = payload(failed.payload).head;
    assert.ok(typeof failedHead === "string" && /^[a-f0-9]{40}$/.test(failedHead), "失败事件必须对应实际 Git 提交。");
    assert.notEqual(failedHead, saved.head, "失败后必须产生修复提交。");
    const cwd = repository.repositoryPath(project.id);
    assert.equal((await repository.repositoryGit(cwd, ["show", `${failedHead}:src/calc.mjs`])).trimEnd(), brokenSource.trimEnd(), "首次失败必须来自原始错误源码。");
    assert.equal((await repository.repositoryGit(cwd, ["show", `${failedHead}:tests/calc.test.mjs`])).trimEnd(), trustedTests.trimEnd(), "失败时不能修改可信测试。");
    const preceding = events.filter(event => event.sequence < failed.sequence && event.type === "execution_progress").at(-1);
    assert.equal(preceding?.message, `正在验证：${command.join(" ")}`, "失败必须来自要求的完整测试命令。");
    const passed = checkpoints.find(event => event.sequence > failed.sequence && payload(event.payload).status === "passed" && payload(event.payload).head === saved.head);
    assert.ok(passed, "必须保留失败后在最终提交通过命令测试的事件。");
    assert.ok(events.some(event => event.type === "execution_progress" && event.message === "正在加载项目技能" && event.sequence < preceding!.sequence), "必须先读取所选技能，再运行首次失败测试。");
    assert.ok(events.some(event => event.type === "execution_progress" && event.message === "正在审查变更差异" && event.sequence > passed.sequence), "最终命令通过后须审查实际差异。");
    assert.ok(events.some(event => event.type === "execution_completed" && payload(event.payload).status === "completed"));
    assert.equal((await work.read("tests/calc.test.mjs")).content, trustedTests, "最终可信测试内容不得变化。");
    const report = await work.read("docs/REPORT.md");
    assert.ok(report.content.includes(marker), "报告必须含仅通过 read_skill 可获得的随机技能标记。");
    const review = await work.diff(baseline);
    assert.ok(review.changedPaths.includes("src/calc.mjs") && review.changedPaths.includes("docs/REPORT.md"));
    assert.ok(review.changedPaths.every(filename => ["src/calc.mjs", "tests/calc.test.mjs", "docs/REPORT.md"].includes(filename) || filename.startsWith(".scenarioforge/skills/")), "不得修改验收任务以外的文件。");
    assert.equal((await repository.repositorySummary(project.id)).head, baseline, "共享 main 不得变化。");
    const independent = await verifyCommand(work, command, context.signal);
    assertPassedCommand(independent, saved.head);
    evidence.independentVerification = independent;
    evidence.passed = true;
    context.diagnostic("真实模型单次验收通过：冻结技能与项目模型配置，观察失败、修复源码、报告含随机标记，可信测试保持不变，最终提交容器复验通过；main 未变。");
  } finally {
    // Capture only whitelisted evidence; never serialize environment, configuration, ciphertext, or raw errors.
    try {
      if (runId) {
        const saved = await db.workspaceExecution.findUnique({ where: { id: runId } });
        if (saved) {
          evidence.execution = { status: saved.status, head: saved.head, attempts: saved.attempts, summary: saved.summary, error: saved.error };
          evidence.checks = JSON.parse(saved.verification ?? "[]");
          evidence.events = (await db.researchEvent.findMany({ where: { packageId: saved.packageId }, orderBy: { sequence: "asc" } })).map(event => {
            const data = payload(event.payload);
            return { sequence: event.sequence, type: event.type, message: event.message, payload: { kind: data.kind, status: data.status, head: data.head } };
          });
        }
      }
      if (work) {
        const files: Record<string, string> = {};
        for (const filename of ["src/calc.mjs", "tests/calc.test.mjs", "docs/REPORT.md"]) {
          const file = await work.read(filename).catch(() => null);
          if (file) files[filename] = file.content;
        }
        evidence.files = files;
      }
      evidence.finishedAt = new Date().toISOString();
      if (reportPath) await writeFile(reportPath, redact(JSON.stringify(evidence, null, 2)) + "\n", { mode: 0o600, flag: "wx" });
    } finally {
      try {
        if (projectId) {
          await db.researchPackage.deleteMany({ where: { projectId } });
          await db.project.deleteMany({ where: { id: projectId } });
        }
        if (userId) await db.user.deleteMany({ where: { id: userId } });
      } finally { await db.$disconnect(); }
    }
  }
});
