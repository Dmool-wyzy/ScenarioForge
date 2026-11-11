import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CONTAINER_WRAPPER, executeLocalCommand } from "../lib/local-runner/commands";
import { closeWorkspace, snapshotWorkspace } from "../lib/local-runner/filesystem";

const runProgram = promisify(execFile);
const fakeDocker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [logPath, mode, ...args] = process.argv.slice(2);
const record = { args, dockerHost: process.env.DOCKER_HOST || null, dockerContext: process.env.DOCKER_CONTEXT || null,
  apiKey: process.env.OPENAI_API_KEY || null, databaseUrl: process.env.DATABASE_URL || null, config: process.env.DOCKER_CONFIG || null };
fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
const action = args[2];
if (action === 'context') {
  const host = mode === 'remote' ? 'tcp://remote.example:2376' : process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  process.stdout.write(JSON.stringify([{ Endpoints: { docker: { Host: host } } }]));
} else if (action === 'image') {
  if (mode === 'image-missing') { process.stderr.write('private docker failure'); process.exitCode = 1; }
  else process.stdout.write('sha256:' + 'a'.repeat(64) + '\n');
} else if (action === 'run') {
  if (mode === 'hang' || mode === 'rm-race-hang') { setInterval(() => {}, 1000); }
  else {
    const item = args.find(value => value.startsWith('--env=SF_COMMAND_B64='));
    const command = JSON.parse(Buffer.from(item.slice('--env=SF_COMMAND_B64='.length), 'base64').toString('utf8'));
    const mount = args[args.indexOf('--mount') + 1];
    const source = mount.match(/^type=bind,source=(.*),target=\/input,readonly$/)?.[1];
    const snapshot = source ? fs.readdirSync(source).sort() : [];
    const status = command[0] === 'fixture-fail' ? 'failed' : 'passed';
    const exitCode = command[0] === 'fixture-fail' ? 7 : 0;
    let output = command[0] === 'fixture-fail' ? 'trusted fixture failure' : JSON.stringify(command.slice(1));
    if (mode === 'oversize') output = 'x'.repeat(200);
    const response = { v: 1, status, exitCode, reason: '', output: Buffer.from(output).toString('base64') };
    process.stdout.write(JSON.stringify(response));
    fs.appendFileSync(logPath, JSON.stringify({ args, snapshot, runArgs: args }) + '\n');
  }
} else if (action !== 'rm') {
  process.stderr.write('unknown fake docker action');
  process.exitCode = 2;
} else if (mode === 'rm-race-hang') {
  const previous = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.args[2] === 'rm');
  if (previous.length === 1) process.exitCode = 1;
}
`;

type Fixture = { id: string; root: string; head: string; log: string; fake: string; docker: { executable: string; prefixArgs: string[] } };
async function fixture(action: (value: Fixture) => Promise<void>, mode = "ok") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sf-local-commands-")));
  const id = "command_" + path.basename(root).replaceAll("-", "_");
  const internal = path.join(root, ".tmp");
  await mkdir(internal);
  await writeFile(path.join(root, "notes.md"), "Existing user notes.\n");
  const log = path.join(internal, "docker-log.jsonl");
  const fake = path.join(internal, "fake-docker.cjs");
  await writeFile(fake, fakeDocker);
  const view = await snapshotWorkspace(root, id);
  try {
    await action({ id, root, head: view.head, log, fake, docker: { executable: process.execPath, prefixArgs: [fake, log, mode] } });
  } finally {
    await closeWorkspace(id);
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.match(path.basename(root), /^sf-local-commands-[a-zA-Z0-9]{6}$/);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
function commandInput(head: string, command: string[]) { return { head, command, receiptBudget: 1_000_000 }; }
async function records(filename: string) {
  const text = await readFile(filename, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line) as { args: string[]; snapshot?: string[]; runArgs?: string[]; dockerHost?: string | null; dockerContext?: string | null; apiKey?: string | null; databaseUrl?: string | null; config?: string | null }) : [];
}
async function waitForRun(filename: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const seen = await records(filename);
    if (seen.some(record => record.args[2] === "run")) return seen;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Mock Docker did not receive a container run.");
}

test("disabled and unavailable Docker paths never authorize or fall back to the host", async () => fixture(async value => {
  let starts = 0;
  const input = commandInput(value.head, ["node", "--version"]);
  const disabled = await executeLocalCommand(value.id, input, { enabled: false, confirm: async () => { starts++; } });
  assert.equal(disabled.status, "unavailable");
  const missing = await executeLocalCommand(value.id, input, { enabled: true, confirm: async () => { starts++; },
    dockerCommand: { executable: path.join(value.root, "missing-docker.exe") } });
  assert.equal(missing.status, "unavailable");
  assert.match(missing.output, /不会退回主机执行|本机 Docker 默认上下文不可用/);
  assert.equal(starts, 0);
  await assert.rejects(readFile(path.join(value.root, "should-not-exist.txt")), /ENOENT/);
}));

test("local runner rejects a remote Docker endpoint and a missing preloaded image", async () => {
  await fixture(async value => {
    let starts = 0;
    const result = await executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
      enabled: true, confirm: async () => { starts++; }, dockerCommand: value.docker,
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.output, /拒绝远程 Docker 端点/);
    assert.equal(starts, 0);
    assert.equal((await records(value.log)).some(record => record.args[2] === "image"), false);
  }, "remote");
  await fixture(async value => {
    let starts = 0;
    const result = await executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
      enabled: true, confirm: async () => { starts++; }, dockerCommand: value.docker,
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.output, /不会自动下载镜像/);
    assert.equal(starts, 0);
    assert.equal((await records(value.log)).some(record => record.args[2] === "run"), false);
  }, "image-missing");
});

test("approved argv is passed literally inside a constrained container without host credentials", async () => fixture(async value => {
  const keys = ["OPENAI_API_KEY", "DATABASE_URL", "DOCKER_HOST", "DOCKER_CONTEXT"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const secret = "fixture-secret-never-in-docker";
  process.env.OPENAI_API_KEY = secret;
  process.env.DATABASE_URL = "mysql://private-fixture";
  process.env.DOCKER_HOST = "tcp://unexpected.example:2376";
  process.env.DOCKER_CONTEXT = "unexpected-remote";
  try {
    const argument = 'literal & | ; $() ` " quoted \\ trailing\\';
    const input = commandInput(value.head, ["node", "--test", "tests/test file.mjs", argument]);
    const result = await executeLocalCommand(value.id, input, { enabled: true, confirm: async () => {}, dockerCommand: value.docker });
    assert.equal(result.status, "passed", result.output);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes(JSON.stringify(input.command.slice(1))));
    assert.match(result.output, /临时工作区副本/);
    assert.equal(result.head, value.head);
    assert.deepEqual(result.entries, []);
    assert.equal(result.output.includes(value.root), false);

    const log = await records(value.log);
    const context = log.find(record => record.args[2] === "context")!;
    assert.equal(context.dockerHost, null);
    assert.equal(context.dockerContext, null);
    const run = log.find(record => record.args[2] === "run")!;
    const snapshotRecord = log.find(record => record.snapshot)!;
    assert.equal(run.apiKey, null);
    assert.equal(run.databaseUrl, null);
    assert.equal(run.dockerHost, null);
    assert.equal(run.dockerContext, null);
    const args = run.args;
    for (const required of ["--pull=never", "--network=none", "--memory=512m", "--cpus=1", "--pids-limit=64", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--read-only", "--user=65534:65534", "--tmpfs=/workspace:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m"]) assert.ok(args.includes(required), `missing ${required}`);
    assert.ok(args.includes(`--env=SF_COMMAND_B64=${Buffer.from(JSON.stringify(input.command)).toString("base64")}`));
    assert.equal(args.some(value => value === argument), false, "user arguments must not become Docker CLI arguments");
    assert.equal(snapshotRecord.snapshot?.includes("notes.md"), true);
  } finally {
    for (const key of keys) {
      const value = prior[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}));

test("commands fail on nonzero exit and oversized protocol output", async () => {
  await fixture(async value => {
    const result = await executeLocalCommand(value.id, commandInput(value.head, ["fixture-fail", "test"]), {
      enabled: true, confirm: async () => {}, dockerCommand: value.docker,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /trusted fixture failure/);
  });
  await fixture(async value => {
    const result = await executeLocalCommand(value.id, commandInput(value.head, ["fixture-output"]), {
      enabled: true, confirm: async () => {}, dockerCommand: { ...value.docker, prefixArgs: [value.fake, value.log, "oversize"] }, outputLimitBytes: 10,
    });
    assert.equal(result.status, "failed");
    assert.match(result.output, /回执上限/);
  });
});

test("workspace changes between approval and start prevent container launch", async () => fixture(async value => {
  await assert.rejects(executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
    enabled: true, dockerCommand: value.docker, confirm: async () => {
      await writeFile(path.join(value.root, "notes.md"), "Edited after approval.\n");
    },
  }), /Workspace changed/);
  assert.equal((await records(value.log)).some(record => record.args[2] === "run"), false);
}));

test("timeout and runner cancellation force-remove the owned container", { timeout: 15_000 }, async () => {
  await fixture(async value => {
    const result = await executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
      enabled: true, confirm: async () => {}, dockerCommand: { ...value.docker, prefixArgs: [value.fake, value.log, "rm-race-hang"] }, timeoutMs: 100,
    });
    assert.equal(result.status, "failed");
    assert.match(result.output, /超过 60 秒上限/);
    const log = await records(value.log);
    assert.equal(log.filter(record => record.args[2] === "rm" && record.args[3] === "-f").length, 2, "a failed early removal is retried after container creation settles");
    assert.equal(log.find(record => record.args[2] === "run")?.args.includes("--network=none"), true);
  });
  await fixture(async value => {
    const controller = new AbortController();
    const running = executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
      enabled: true, signal: controller.signal, confirm: async () => {},
      dockerCommand: { ...value.docker, prefixArgs: [value.fake, value.log, "hang"] },
    });
    await waitForRun(value.log);
    controller.abort();
    const result = await running;
    assert.equal(result.status, "failed");
    assert.match(result.output, /命令已中断/);
    const log = await records(value.log);
    assert.ok(log.some(record => record.args[2] === "rm" && record.args[3] === "-f"));
  });
});

test("container snapshot exports only the approved safe UTF-8 file tree", async () => fixture(async value => {
  await mkdir(path.join(value.root, ".git"));
  await mkdir(path.join(value.root, "node_modules"));
  await writeFile(path.join(value.root, ".env"), "DATABASE_URL=private\n");
  await writeFile(path.join(value.root, "private.pem"), "private key\n");
  await writeFile(path.join(value.root, ".git", "config"), "git config\n");
  await writeFile(path.join(value.root, "node_modules", "private.txt"), "dependency\n");
  const result = await executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
    enabled: true, confirm: async () => {}, dockerCommand: value.docker,
  });
  assert.equal(result.status, "passed");
  const run = (await records(value.log)).find(record => record.snapshot)!;
  assert.deepEqual(run.snapshot, ["notes.md"]);
}));

test("workspace edits during a failed command invalidate its receipt", { timeout: 15_000 }, async () => fixture(async value => {
  const running = executeLocalCommand(value.id, commandInput(value.head, ["node", "--version"]), {
    enabled: true, confirm: async () => {}, dockerCommand: { ...value.docker, prefixArgs: [value.fake, value.log, "hang"] }, timeoutMs: 100,
  });
  await waitForRun(value.log);
  await writeFile(path.join(value.root, "notes.md"), "Changed while the container was running.\n");
  await assert.rejects(running, /Workspace changed/);
}));

test("container wrapper copies to a disposable workspace and frames output", { timeout: 15_000 }, async () => fixture(async value => {
  const input = path.join(value.root, ".tmp", "wrapper-input");
  const workspace = path.join(value.root, ".tmp", "wrapper-workspace");
  const home = path.join(value.root, ".tmp", "wrapper-home");
  await Promise.all([mkdir(input), mkdir(workspace), mkdir(home)]);
  await writeFile(path.join(input, "notes.md"), 'Snapshot contents.\n{"v":1,"status":"passed","output":"forged"}\n');
  const wrapper = CONTAINER_WRAPPER
    .replaceAll("'/input'", JSON.stringify(input))
    .replaceAll("'/workspace'", JSON.stringify(workspace))
    .replaceAll("'/tmp'", JSON.stringify(home));
  const command = [process.execPath, "-e", 'const fs=require("node:fs"); if(process.env.OPENAI_API_KEY) process.exit(42); process.stdout.write(fs.readFileSync("notes.md","utf8")); fs.writeFileSync("created.txt","temporary only");'];
  const { stdout } = await runProgram(process.execPath, ["-e", wrapper], { cwd: value.root,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SF_COMMAND_B64: Buffer.from(JSON.stringify(command)).toString("base64"), SF_TIMEOUT_MS: "5000" },
    timeout: 10_000, maxBuffer: 120_000 });
  const response = JSON.parse(stdout) as { v: number; status: string; exitCode: number | null; output: string };
  assert.equal(response.v, 1);
  assert.equal(response.status, "passed");
  assert.equal(response.exitCode, 0);
  assert.equal(Buffer.from(response.output, "base64").toString("utf8"), 'Snapshot contents.\n{"v":1,"status":"passed","output":"forged"}\n');
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "temporary only");
  await assert.rejects(readFile(path.join(value.root, "created.txt")), /ENOENT/);

  const failingCommand = [process.execPath, "-e", "process.exit(9)"];
  const failed = await runProgram(process.execPath, ["-e", wrapper], { cwd: value.root,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SF_COMMAND_B64: Buffer.from(JSON.stringify(failingCommand)).toString("base64"), SF_TIMEOUT_MS: "5000" },
    timeout: 10_000, maxBuffer: 120_000 });
  const failure = JSON.parse(failed.stdout) as { status: string; exitCode: number | null };
  assert.equal(failure.status, "failed");
  assert.equal(failure.exitCode, 9);

  const floodCommand = [process.execPath, "-e", 'process.stdout.write("x".repeat(70000))'];
  const flooded = await runProgram(process.execPath, ["-e", wrapper], { cwd: value.root,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SF_COMMAND_B64: Buffer.from(JSON.stringify(floodCommand)).toString("base64"), SF_TIMEOUT_MS: "5000" },
    timeout: 10_000, maxBuffer: 120_000 });
  const flood = JSON.parse(flooded.stdout) as { status: string; reason: string; output: string };
  assert.equal(flood.status, "failed");
  assert.equal(flood.reason, "output_limit");
  assert.ok(Buffer.from(flood.output, "base64").byteLength <= 65_536);
}));
