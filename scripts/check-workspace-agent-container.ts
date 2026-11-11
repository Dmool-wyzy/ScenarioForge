import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

// Deliberate opt-in comes before application imports, Git setup or Docker access.
assert.equal(process.env.SCENARIOFORGE_TEST_DOCKER, "1",
  "尚未授权本地 Docker 验收。确认本地 Docker 与已有 node:24-alpine 镜像后，设置 SCENARIOFORGE_TEST_DOCKER=1 再运行；此脚本不安装或下载任何环境。");

const exec = promisify(execFile);

test("real local Docker verifies failure, repair and container isolation", { timeout: 180000 }, async context => {
  // Match the production verifier's environment. Reading context metadata does
  // not contact the daemon; reject remote endpoints before any daemon request.
  const dockerEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
    "此验收只使用本机 Docker；请先移除当前测试进程中的 DOCKER_HOST 和 DOCKER_CONTEXT。");
  const metadata = await exec("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    { env: dockerEnv, timeout: 10000, maxBuffer: 2000, windowsHide: true, signal: context.signal });
  const endpoint: unknown = JSON.parse(metadata.stdout.trim());
  assert.ok(typeof endpoint === "string" && (/^unix:\/\/\/[\w/.-]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/.test(endpoint)),
    "当前 Docker context 不是本机 Unix socket 或 Windows named pipe；未连接 Docker daemon。");

  const { initializeDemoRepository, repositorySummary } = await import("../lib/repository");
  const { commitRepositoryFiles } = await import("../lib/repository-workspace");
  const { AgentWorkspace, prepareAgentWorkspace } = await import("../lib/workspace-agent/workspace");
  const { verifyCommand } = await import("../lib/workspace-agent/verification");
  const root = await mkdtemp(path.join(tmpdir(), "sf-container-acceptance-"));
  const previousRoot = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  const secretKey = "SF_DOCKER_ACCEPTANCE_SECRET_" + path.basename(root).replace(/\W/g, "_").toUpperCase();
  process.env[secretKey] = "fixture-only-must-stay-on-host";
  const actor = { id: "container-test-user", username: "Container acceptance", owner: false };
  const command = ["node", "--test", "tests/calc.test.mjs", "tests/isolation.test.mjs"];
  const source = (operator: string) => "export function add(a, b) { return a " + operator + " b; }\n";
  const testSource = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { add } from "../src/calc.mjs";',
    'test("addition acceptance", () => { assert.equal(add(2, 3), 5); });',
    "",
  ].join("\n");
  const isolationSource = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { access, readFile, writeFile } from "node:fs/promises";',
    'test("container isolation acceptance", async () => {',
    '  assert.equal(process.getuid(), 65534);',
    '  assert.equal(process.getgid(), 65534);',
    '  for (const key of ["DATABASE_URL", "OPENAI_API_KEY", "EMBEDDING_API_KEY", "SCENARIOFORGE_INTERNAL_TOKEN", "SCENARIOFORGE_SETTINGS_KEY"]) assert.equal(process.env[key], undefined);',
    "  assert.equal(process.env[" + JSON.stringify(secretKey) + "], undefined);",
    '  await assert.rejects(access("/workspace/.env.local"));',
    '  await assert.rejects(access("/workspace/.git"));',
    '  await assert.rejects(access("/var/run/docker.sock"));',
    '  assert.match(await readFile("/workspace/src/calc.mjs", "utf8"), /export function add/);',
    '  await assert.rejects(writeFile("/workspace/should-not-exist.txt", "forbidden"));',
    '  await writeFile("/tmp/sf-container-write-test.txt", "temporary output");',
    '  assert.equal(await readFile("/tmp/sf-container-write-test.txt", "utf8"), "temporary output");',
    '});',
    "",
  ].join("\n");
  try {
    await initializeDemoRepository("container-test-project");
    const baseline = (await repositorySummary("container-test-project")).head;
    const prepared = await prepareAgentWorkspace("container-test-project", "docker-acceptance", actor, [], baseline);
    const workspace = new AgentWorkspace("container-test-project", prepared.branch, actor);
    await workspace.write(prepared.head, [
      { path: "src/calc.mjs", content: source("-") },
      { path: "tests/calc.test.mjs", content: testSource },
      { path: "tests/isolation.test.mjs", content: isolationSource },
    ], "创建计算函数与容器验收测试");
    // Manual Git content checks that sensitive files are excluded during export.
    await commitRepositoryFiles("container-test-project", actor, prepared.branch, (await workspace.list()).head,
      "添加仅用于检查导出过滤的假环境文件", [{ path: ".env.local", content: "FIXTURE_ONLY=must-not-be-exported\n" }]);

    const failed = await verifyCommand(workspace, command, context.signal);
    assert.notEqual(failed.status, "unavailable", "Docker 验收未运行：" + failed.output);
    assert.equal(failed.status, "failed", "错误计算函数应使真实测试失败：" + failed.output);
    assert.match(failed.output, /addition acceptance/);
    assert.match(failed.output, /container isolation acceptance/);
    assert.match(failed.output, /ERR_ASSERTION/);
    const failedHead = failed.head;

    const latest = await workspace.read("src/calc.mjs");
    await workspace.write(latest.head, [{ path: latest.path, content: source("+") }], "修复加法实现");
    const passed = await verifyCommand(workspace, command, context.signal);
    assert.notEqual(passed.status, "unavailable", "Docker 验收未运行：" + passed.output);
    assert.equal(passed.status, "passed", "修复后真实测试应通过：" + passed.output);
    assert.notEqual(passed.head, failedHead);
    assert.match(passed.output, /addition acceptance/);
    assert.match(passed.output, /container isolation acceptance/);
    assert.equal((await repositorySummary("container-test-project")).head, baseline, "容器验收不能改变共享 main。");
    context.diagnostic("真实本地 Docker：错误实现测试失败，修复后通过；非 root、凭据隔离、敏感路径过滤与只读源码断言通过。未使用数据库或模型服务。");
  } finally {
    delete process.env[secretKey];
    if (previousRoot === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT;
    else process.env.SCENARIOFORGE_GIT_ROOT = previousRoot;
    const resolvedRoot = path.resolve(root);
    assert.equal(path.dirname(resolvedRoot), path.resolve(tmpdir()), "只能清理本脚本创建的临时目录。");
    assert.ok(path.basename(resolvedRoot).startsWith("sf-container-acceptance-"));
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
