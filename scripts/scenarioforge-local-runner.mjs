import { chmod, mkdir, readFile, writeFile, lstat, open, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotWorkspace, listWorkspace, readWorkspace, writeWorkspace, inspectWorkspace, closeWorkspace } from "../lib/local-runner/filesystem.ts";
import { executeLocalCommand } from "../lib/local-runner/commands.ts";
import { runnerDirectory } from "../lib/local-runner/directory.ts";

const configDirectory = process.env.APPDATA ? path.join(process.env.APPDATA, "ScenarioForge") : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "scenarioforge");
const configPath = path.join(configDirectory, "runner.json");
function args(argv, allowed, flags = []) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith("--")) throw new Error("Unexpected argument " + argv[index]);
    const key = argv[index].slice(2);
    if (!allowed.includes(key) || key in result) throw new Error("Unknown or duplicate option --" + key);
    if (flags.includes(key)) result[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --" + key);
      result[key] = value;
    }
  }
  return result;
}
async function request(url, options = {}) {
  const { timeoutMs = 65000, signal, ...fetchOptions } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...fetchOptions, headers: { "Content-Type": "application/json", ...(options.headers || {}) }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "ScenarioForge request failed: " + response.status);
  return body;
}
function baseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol) || (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) throw new Error("Use HTTPS for remote ScenarioForge servers.");
  return url.origin;
}
async function pair(options) {
  if (!options.url || !options.code || !options.directory) throw new Error("pair requires --url, --code, and --directory.");
  const root = await realpath(path.resolve(options.directory));
  runnerDirectory.parse(root);
  if (!(await lstat(root)).isDirectory()) throw new Error("Selected workspace must be a directory.");
  const configRelative = path.relative(root, configPath);
  if (!configRelative.startsWith(".." + path.sep) && configRelative !== ".." && !path.isAbsolute(configRelative)) throw new Error("Runner credentials must be stored outside the selected workspace. Select a project directory.");
  const paired = await request(baseUrl(options.url) + "/api/local-runner/pair", { method: "POST", body: JSON.stringify({ code: options.code, workspaceDirectory: root }) });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const config = { ...paired, server: baseUrl(options.url), directory: root };
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: "w" });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  process.stdout.write("Paired " + paired.label + " with the selected local directory.\nConfig: " + configPath + "\n");
}
async function run(options) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (await realpath(config.directory) !== config.directory) throw new Error("The selected workspace directory has changed. Pair it again.");
  runnerDirectory.parse(config.directory);
  const endpoint = baseUrl(config.server) + "/api/local-runner/" + encodeURIComponent(config.runnerId) + "/commands";
  const lockDirectory = path.join(configDirectory, "locks");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockDirectory, createHash("sha256").update(process.platform === "win32" ? config.directory.toLowerCase() : config.directory).digest("hex") + ".json");
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
  } catch (error) {
    if (error?.code === "EEXIST") {
      const previous = JSON.parse(await readFile(lockPath, "utf8"));
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (cause) { if (cause?.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Another Runner already owns this workspace. Stop it before starting a second Runner.");
      throw new Error("A stale workspace lock remains. After checking that the previous Runner has stopped, remove this lock and start again: " + lockPath);
    } else throw error;
  }
  const releaseLock = async () => {
    try { const owner = JSON.parse(await readFile(lockPath, "utf8")); if (owner.pid === process.pid) await unlink(lockPath); } catch {}
  };
  const stopped = new AbortController();
  const shutdown = () => stopped.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  process.stdout.write("ScenarioForge local Runner active for: " + config.directory + "\nPress Ctrl+C to stop.\n");
  process.stdout.write(options["allow-commands"] ? "Local commands enabled. Each command still requires one approval in the web page; commands run in a network-disabled Docker container using an exported temporary snapshot. Container writes are discarded.\n" : "Local commands disabled. To enable individually approved commands, start with run --allow-commands.\n");
  let wait = 1000;
  const initialized = new Set();
  let reportedDirectory = false;
  const redact = value => [config.token, configPath, config.directory, config.directory.replaceAll("\\", "/")].reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value);
  try { while (!stopped.signal.aborted) {
    try {
      if (!reportedDirectory) {
        await request(endpoint, { method: "PUT", headers: { Authorization: "Bearer " + config.token }, body: JSON.stringify({ workspaceDirectory: config.directory }), signal: stopped.signal });
        reportedDirectory = true;
      }
      const { command } = await request(endpoint, { headers: { Authorization: "Bearer " + config.token }, signal: stopped.signal });
      wait = 1000;
      if (command) {
        let result, error;
        try {
          if (!initialized.has(command.executionId)) {
            for (const previous of initialized) { await closeWorkspace(previous); initialized.delete(previous); }
            await snapshotWorkspace(config.directory, command.executionId);
            initialized.add(command.executionId);
          }
          if (command.operation === "list") result = await listWorkspace(command.executionId);
          else if (command.operation === "read") result = await readWorkspace(command.executionId, command.input.path);
          else if (command.operation === "write") result = await writeWorkspace(command.executionId, command.input.head, command.input.changes, command.input.receiptBudget);
          else if (command.operation === "inspect") result = await inspectWorkspace(command.executionId, command.input.paths);
          else if (command.operation === "exec") {
            let started = false;
            result = await executeLocalCommand(command.executionId, command.input, {
              enabled: Boolean(options["allow-commands"]), signal: stopped.signal, redact,
              confirm: async () => {
                await request(endpoint, { method: "POST", headers: { Authorization: "Bearer " + config.token }, timeoutMs: 3000, signal: stopped.signal,
                  body: JSON.stringify({ action: started ? "confirm" : "start", commandId: command.id, leaseOwner: command.leaseOwner }) });
                started = true;
              },
            });
          }
          else throw new Error("Unsupported local Runner operation.");
        }
        catch (cause) { error = redact(cause instanceof Error ? cause.message : "Local operation failed."); }
        const body = JSON.stringify({ commandId: command.id, leaseOwner: command.leaseOwner, result, error });
        // Retry delivery of the same receipt; never repeat a filesystem write.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await request(endpoint, { method: "POST", headers: { Authorization: "Bearer " + config.token }, body, signal: stopped.signal }); break; }
          catch (cause) { if (stopped.signal.aborted || attempt === 2) throw cause; await new Promise(resolve => setTimeout(resolve, 500)); }
        }
      } else await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (cause) {
      if (stopped.signal.aborted) break;
      const message = redact(cause instanceof Error ? cause.message : "Runner network error.");
      process.stderr.write(message + "\n");
      if (/令牌无效|expired|revoked|失去项目权限|绑定目录已变化/i.test(message)) throw cause;
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 10000);
    }
  } } finally {
    process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
    for (const executionId of initialized) await closeWorkspace(executionId);
    await releaseLock();
  }
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "pair") return pair(args(rest, ["url", "code", "directory"]));
  if (command === "run") return run(args(rest, ["allow-commands"], ["allow-commands"]));
  throw new Error("Usage: node scripts/scenarioforge-local-runner.mjs pair --url URL --code CODE --directory PATH | run [--allow-commands]");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
}
