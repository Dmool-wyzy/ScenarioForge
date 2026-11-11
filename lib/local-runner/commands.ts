import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorkspace, readWorkspace, withWorkspaceCommand } from "./filesystem";

export type LocalCommandInput = { head: string; command: string[]; receiptBudget: number };
export type LocalCommandResult = {
  beforeHead: string; head: string; kind: "command"; command: string[];
  status: "passed" | "failed" | "unavailable"; output: string;
  exitCode?: number | null;
  entries: { path: string; before: string | null; after: string | null }[];
};
export type LocalCommandOptions = {
  enabled: boolean; signal?: AbortSignal; confirm: () => Promise<void>;
  redact?: (text: string) => string;
  /** Test seams; production callers use the local Docker CLI and fixed limits. */
  dockerCommand?: { executable: string; prefixArgs?: string[] };
  timeoutMs?: number; outputLimitBytes?: number;
};

const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const COMMAND_OUTPUT_LIMIT = 65_536;
const DOCKER_RESPONSE_LIMIT = 120_000;
const DOCKER_ERROR_LIMIT = 16_000;
const WORKSPACE_NOTE = "容器内运行的是临时工作区副本；命令对文件的新增或修改会丢弃。需要修改项目文件时请使用文件变更工具。";

export const CONTAINER_WRAPPER = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const raw = process.env.SF_COMMAND_B64 || '';
const timeoutValue = Number(process.env.SF_TIMEOUT_MS || 60000);
delete process.env.SF_COMMAND_B64;
delete process.env.SF_TIMEOUT_MS;
const outputLimit = 65536;
const chunks = [];
let outputBytes = 0;
let child;
let finished = false;
let stopReason = '';
let watchdog;
let killTimer;
let finishTimer;
function killGroup(signal) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); } catch (_) {}
}
function result(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  clearTimeout(killTimer);
  clearTimeout(finishTimer);
  const body = JSON.stringify({ v: 1, status: stopReason ? 'failed' : code === 0 ? 'passed' : 'failed',
    exitCode: Number.isInteger(code) ? code : null, reason: stopReason,
    output: Buffer.concat(chunks).toString('base64') });
  process.stdout.end(body, () => process.exit(0));
}
function stop(reason) {
  if (finished || stopReason) return;
  stopReason = reason;
  killGroup('SIGTERM');
  killTimer = setTimeout(() => killGroup('SIGKILL'), 200);
  finishTimer = setTimeout(() => result(null), 350);
}
async function copyDirectory(source, destination) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { mode: 0o755 });
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      const info = await fs.stat(from);
      await fs.chmod(to, info.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error('unsafe snapshot entry');
    }
  }
}
async function main() {
  const command = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  if (!Array.isArray(command) || !command.length || command.length > 20 || command.some(part => typeof part !== 'string' || !part || part.length > 1000)) {
    throw new Error('invalid command');
  }
  await copyDirectory('/input', '/workspace');
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', TMP: '/tmp', TMPDIR: '/tmp' };
  child = spawn(command[0], command.slice(1), { cwd: '/workspace', env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = chunk => {
    if (finished || stopReason) return;
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, outputLimit - outputBytes);
    if (remaining) chunks.push(buffer.subarray(0, remaining));
    outputBytes += buffer.length;
    if (outputBytes > outputLimit) stop('output_limit');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', () => result(null));
  child.once('exit', code => {
    killGroup('SIGTERM');
    finishTimer = setTimeout(() => result(code), 75);
  });
  const timeout = Number.isFinite(timeoutValue) ? Math.min(60000, Math.max(1, timeoutValue)) : 60000;
  watchdog = setTimeout(() => stop('timeout'), timeout);
}
main().catch(() => result(null));
`;

type CliResult = { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException; stopped?: "timeout" | "output_limit" | "aborted" };
type CliOptions = {
  executable: string; prefixArgs: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; outputLimit: number;
  signal?: AbortSignal; onStop?: () => Promise<void>;
};
type SnapshotFile = { path: string; content: string; mode: "100644" | "100755" };
type ExportedSnapshot = { files: SnapshotFile[]; size: number };

function dockerEnvironment(configDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", DOCKER_CONFIG: configDirectory, HOME: configDirectory, USERPROFILE: configDirectory,
    APPDATA: configDirectory, TEMP: configDirectory, TMP: configDirectory, TMPDIR: configDirectory };
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function invokeDocker(args: string[], options: CliOptions): Promise<CliResult> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...options.prefixArgs, "--context", "default", ...args], {
        env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error as NodeJS.ErrnoException });
      return;
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let total = 0, settled = false, stopReason: CliResult["stopped"], cleanup: Promise<void> | undefined;
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      const buffer = Buffer.from(chunk), remaining = Math.max(0, options.outputLimit - total);
      if (remaining) target.push(buffer.subarray(0, remaining));
      total += buffer.length;
      if (total > options.outputLimit) stop("output_limit");
    };
    const stop = (reason: NonNullable<CliResult["stopped"]>) => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (child.pid) child.kill("SIGKILL");
      if (options.onStop) cleanup = new Promise(resolve => setTimeout(() => {
        void options.onStop!().catch(() => {}).finally(resolve);
      }, 200));
    };
    const onAbort = () => stop("aborted");
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", error => { (child as ChildProcess & { spawnError?: NodeJS.ErrnoException }).spawnError = error as NodeJS.ErrnoException; });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.once("close", async code => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      await cleanup;
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
        error: (child as ChildProcess & { spawnError?: NodeJS.ErrnoException }).spawnError, stopped: stopReason });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function localEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value === "unix:///var/run/docker.sock" || value === "unix:///run/docker.sock" || value === "npipe:////./pipe/docker_engine";
}

function unavailable(input: LocalCommandInput, output: string): LocalCommandResult {
  return { beforeHead: input.head, head: input.head, kind: "command", command: input.command, status: "unavailable", entries: [], output };
}

function validate(input: LocalCommandInput) {
  if (!input || !/^[a-f0-9]{40}$/.test(input.head) || !Array.isArray(input.command) || !input.command.length || input.command.length > 20 ||
      input.command.some(value => typeof value !== "string" || !value || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("Approved command must contain a valid tree head and 1–20 plain arguments.");
  }
}

async function exportSnapshot(executionId: string, head: string): Promise<ExportedSnapshot | null> {
  const view = await listWorkspace(executionId, "", head);
  if (view.total > 300) return null;
  const files: { path: string; content: string; mode: "100644" | "100755" }[] = [];
  let size = 0;
  for (const entry of view.files) {
    const file = await readWorkspace(executionId, entry.path, head);
    size += Buffer.byteLength(file.content, "utf8");
    if (size > SNAPSHOT_LIMIT) return null;
    files.push({ path: file.path, content: file.content, mode: entry.mode });
  }
  return { files, size };
}

async function writeSnapshot(directory: string, files: SnapshotFile[]) {
  for (const file of files) {
    const target = path.join(directory, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, file.content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
}

function decodedResult(stdout: string) {
  const value = JSON.parse(stdout) as { v?: unknown; status?: unknown; exitCode?: unknown; reason?: unknown; output?: unknown };
  if (value.v !== 1 || (value.status !== "passed" && value.status !== "failed") ||
      !(value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) ||
      typeof value.reason !== "string" || typeof value.output !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.output)) {
    throw new Error("Invalid container response.");
  }
  const output = Buffer.from(value.output, "base64");
  if (output.byteLength > COMMAND_OUTPUT_LIMIT) throw new Error("Container output exceeded its fixed limit.");
  return { status: value.status, exitCode: value.exitCode as number | null, reason: value.reason, output: output.toString("utf8") };
}

export async function executeLocalCommand(executionId: string, input: LocalCommandInput, options: LocalCommandOptions): Promise<LocalCommandResult> {
  validate(input);
  options.signal?.throwIfAborted();
  if (!options.enabled) {
    const view = await listWorkspace(executionId);
    return unavailable({ ...input, head: view.head }, "命令未执行：Runner 未启用命令执行。请在本机以 run --allow-commands 启动；每条命令仍须在网页单独批准。");
  }
  const outputLimit = Math.min(COMMAND_OUTPUT_LIMIT, Math.max(1, options.outputLimitBytes ?? COMMAND_OUTPUT_LIMIT));
  const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 60_000));
  const exported = await exportSnapshot(executionId, input.head);
  if (!exported) return unavailable(input, "命令未执行：安全工作区快照超过 300 个文件或 4 MiB 上限。");

  const temporary = await mkdtemp(path.join(tmpdir(), "sf-local-command-"));
  const inputDirectory = path.join(temporary, "input");
  const configDirectory = path.join(temporary, "docker-config");
  let ownedContainer = false;
  let removePromise: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let interruption = "";
  const commandController = new AbortController();
  const docker = options.dockerCommand ?? { executable: "docker", prefixArgs: [] };
  const env = dockerEnvironment(configDirectory);
  const dockerCall = (args: string[], timeout: number, limit: number, signal?: AbortSignal) => invokeDocker(args, {
    executable: docker.executable, prefixArgs: docker.prefixArgs ?? [], env, timeoutMs: timeout, outputLimit: limit, signal,
  });
  const removeContainer = () => {
    if (!ownedContainer) return Promise.resolve();
    return removePromise ??= (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await dockerCall(["rm", "-f", containerName], 2500, 1024).catch(() => null);
        if (result?.code === 0) return;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    })();
  };
  const containerName = `sf-local-${randomUUID().replaceAll("-", "")}`;
  const onAbort = () => { interruption = "命令已中断：任务停止、授权失效或 Runner 退出。"; commandController.abort(); };

  try {
    await mkdir(inputDirectory, { recursive: false, mode: 0o755 });
    await mkdir(configDirectory, { recursive: false, mode: 0o700 });
    const snapshot = await realpath(inputDirectory);
    if (!path.isAbsolute(snapshot) || /[\u0000\r\n,]/.test(snapshot)) return unavailable(input, "命令未执行：本机临时快照路径不适用于 Docker 挂载。");
    await writeSnapshot(snapshot, exported.files);

    const context = await dockerCall(["context", "inspect", "default"], 10_000, 16_000, options.signal);
    options.signal?.throwIfAborted();
    if (context.code !== 0 || context.error || context.stopped) return unavailable(input, "命令未执行：本机 Docker 默认上下文不可用；未尝试主机执行。");
    let endpoint: unknown;
    try { endpoint = (JSON.parse(context.stdout) as Array<{ Endpoints?: { docker?: { Host?: unknown } } }>)[0]?.Endpoints?.docker?.Host; }
    catch { endpoint = undefined; }
    if (!localEndpoint(endpoint)) return unavailable(input, "命令未执行：Docker 默认上下文不是受支持的本机 Unix/named-pipe 引擎；拒绝远程 Docker 端点。");

    const image = await dockerCall(["image", "inspect", "--format={{.Id}}", "node:24-alpine"], 10_000, 16_000, options.signal);
    options.signal?.throwIfAborted();
    const imageId = image.stdout.trim();
    if (image.code !== 0 || image.error || image.stopped || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      return unavailable(input, "命令未执行：本机 Docker 或预装的 node:24-alpine 镜像不可用；不会自动下载镜像。");
    }

    const result = await withWorkspaceCommand(executionId, input.head, input.receiptBudget, async (_root, assertUnchanged) => {
      options.signal?.throwIfAborted();
      await assertUnchanged();
      await options.confirm();
      options.signal?.throwIfAborted();
      await assertUnchanged();
      if (options.signal?.aborted) options.signal.throwIfAborted();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      heartbeat = setInterval(() => {
        if (checking || commandController.signal.aborted) return;
        checking = true;
        void options.confirm().catch(() => {
          interruption = "命令已中断：任务停止、连接撤销或本次命令授权失效。";
          commandController.abort();
        }).finally(() => { checking = false; });
      }, 2000);

      ownedContainer = true;
      const encodedCommand = Buffer.from(JSON.stringify(input.command), "utf8").toString("base64");
      const args = ["run", "--rm", "--name", containerName, "--label", "com.scenarioforge.local-command=true", "--pull=never",
        "--network=none", "--memory=512m", "--cpus=1", "--pids-limit=64", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--read-only", "--user=65534:65534", "--mount", `type=bind,source=${snapshot},target=/input,readonly`,
        "--tmpfs=/workspace:rw,noexec,nosuid,nodev,size=64m", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m",
        "--workdir=/tmp", `--env=SF_COMMAND_B64=${encodedCommand}`, `--env=SF_TIMEOUT_MS=${timeoutMs}`,
        "--entrypoint=node", imageId, "-e", CONTAINER_WRAPPER];
      const run = await invokeDocker(args, { executable: docker.executable, prefixArgs: docker.prefixArgs ?? [], env,
        timeoutMs: timeoutMs + 1500, outputLimit: DOCKER_RESPONSE_LIMIT + DOCKER_ERROR_LIMIT, signal: commandController.signal,
        onStop: removeContainer });
      if (run.stopped || run.error || run.code !== 0) await removeContainer();
      else ownedContainer = false;
      options.signal?.removeEventListener("abort", onAbort);
      clearInterval(heartbeat);
      await assertUnchanged();
      if (commandController.signal.aborted) {
        return { status: "failed" as const, exitCode: null, output: interruption || "命令已中断。" };
      }
      if (run.stopped === "timeout") return { status: "failed" as const, exitCode: null, output: "命令超过 60 秒上限，已移除容器。" };
      if (run.stopped === "output_limit") return { status: "failed" as const, exitCode: null, output: "Docker 返回内容超过协议上限，已移除容器。" };
      if (run.error || run.code !== 0) return { status: "unavailable" as const, output: "命令未能在本机隔离容器中启动；不会退回主机执行。" };

      let response: ReturnType<typeof decodedResult>;
      try { response = decodedResult(run.stdout); }
      catch { return { status: "unavailable" as const, output: "命令未返回有效的隔离容器回执；不会退回主机执行。" }; }
      if (response.reason === "timeout") return { status: "failed" as const, exitCode: response.exitCode, output: "命令超过 60 秒上限，容器已停止。" + (response.output ? `\n${response.output}` : "") };
      if (response.reason === "output_limit") return { status: "failed" as const, exitCode: response.exitCode, output: "命令输出超过 64 KiB 上限，容器已停止。" + (response.output ? `\n${response.output}` : "") };
      if (response.status !== "passed" || response.exitCode !== 0) return { status: "failed" as const, exitCode: response.exitCode, output: response.output || "容器内命令执行失败。" };
      if (Buffer.byteLength(response.output, "utf8") > outputLimit) return { status: "failed" as const, exitCode: response.exitCode, output: "命令输出超过本次回执上限。" };
      return { status: "passed" as const, exitCode: response.exitCode, output: response.output || "容器内命令退出码为 0。" };
    });

    const safe = (text: string) => {
      let value = text.split(snapshot).join("[workspace snapshot]").split(snapshot.replaceAll("\\", "/")).join("[workspace snapshot]");
      value = options.redact ? options.redact(value) : value;
      return value.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
    };
    if (result.head !== input.head || result.entries.length) throw new Error("Workspace changed during command verification; the result was discarded.");
    return { beforeHead: result.beforeHead, head: result.head, command: input.command, kind: "command", entries: [],
      status: result.value.status, ...( "exitCode" in result.value ? { exitCode: result.value.exitCode } : {}),
      output: safe(`${result.value.output}\n${WORKSPACE_NOTE}`).slice(-12_000) };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    clearInterval(heartbeat);
    await removeContainer();
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
