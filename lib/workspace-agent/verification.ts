import "server-only";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import ts from "typescript";
import { ApiError } from "../errors";
import { agentFilePath } from "./workspace";
import type { WorkspacePort } from "./port";
import type { Verification } from "./types";

const exec = promisify(execFile);
export function syntaxDiagnostic(filename: string, content: string): string | null {
  if (/\.json$/i.test(filename)) {
    try { JSON.parse(content); return null; } catch { return `${filename}: JSON 格式不正确。`; }
  }
  if (/\.[cm]?[jt]sx?$/i.test(filename)) {
    const source = ts.createSourceFile(filename, content, ts.ScriptTarget.ES2022, true);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
    return diagnostics.length ? diagnostics.map(item => `${filename}: ${ts.flattenDiagnosticMessageText(item.messageText, " ")}`).join("\n") : null;
  }
  return null;
}
export async function verifySyntax(workspace: WorkspacePort): Promise<Verification> {
  const view = await workspace.list();
  if (view.total > 300) throw new ApiError(413, "自动验证基线最多检查 300 个文件，请缩小工作区。");
  const messages: string[] = [], checked: string[] = [], skipped: string[] = [];
  const buffered = new Map<string, string>();
  if (workspace.readMany) {
    const filenames = view.files.filter(file => !file.path.startsWith(".scenarioforge/") && /\.(json|[cm]?[jt]sx?)$/i.test(file.path)).map(file => file.path);
    for (let index = 0; index < filenames.length; index += 8) {
      const batch = await workspace.readMany(filenames.slice(index, index + 8));
      if (batch.head !== view.head) throw new ApiError(409, "验证期间工作区发生变化，请重新验证。");
      for (const file of batch.files) buffered.set(file.path, file.content);
    }
  }
  for (const file of view.files) {
    if (file.path.startsWith(".scenarioforge/") || !/\.(json|[cm]?[jt]sx?)$/i.test(file.path)) { skipped.push(file.path); continue; }
    const { content, head } = buffered.has(file.path) ? { content: buffered.get(file.path)!, head: view.head } : await workspace.read(file.path);
    if (head !== view.head) throw new ApiError(409, "验证期间分支发生变化，请重新验证。");
    checked.push(file.path);
    const error = syntaxDiagnostic(file.path, content);
    if (error) messages.push(error);
  }
  if ((await workspace.list()).head !== view.head) throw new ApiError(409, "验证期间分支发生变化，请重新验证。");
  return { head: view.head, kind: "syntax", status: messages.length ? "failed" : checked.length ? "passed" : "unavailable",
    output: [`静态语法检查（不运行程序、不检查类型、不代表测试通过）：${checked.length} 个 JS/TS/JSON 文件。`, ...messages,
      skipped.length ? `${skipped.length} 个其他文件未作语法验证。` : ""].filter(Boolean).join("\n") };
}
export function containerArguments(name: string, directory: string, command: string[]) {
  if (!path.isAbsolute(directory) || /[\0\r\n,]/.test(directory)) throw new ApiError(503, "隔离验证挂载目录配置无效。");
  return ["run", "--name", name, "--pull=never", "--network=none", "--memory=512m", "--cpus=1", "--pids-limit=64", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--read-only", "--tmpfs=/tmp:rw,noexec,nosuid,size=128m", "--user=65534:65534",
    "--mount", `type=bind,source=${directory},target=/workspace,readonly`, "--workdir=/workspace", "--env=HOME=/tmp", "node:24-alpine", ...command];
}
export async function writeVerificationFile(directory: string, filename: string, content: string) {
  agentFilePath(filename, true);
  const target = path.join(directory, filename);
  let parent = directory;
  // Explicit permissions are needed even when the service uses a restrictive umask:
  // the unprivileged container must be able to traverse the mounted export.
  for (const part of filename.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(parent, 0o755);
  }
  await writeFile(target, content, { mode: 0o644 });
  await chmod(target, 0o644);
}
/**
 * Create an owned, private export snapshot parent. Production may configure a
 * daemon-visible host path while local development retains the OS temp dir.
 */
export async function createVerificationSnapshotDirectory(configuredRoot = process.env.SCENARIOFORGE_EXECUTION_EXPORT_ROOT) {
  if (configuredRoot === undefined) return mkdtemp(path.join(tmpdir(), "sf-execution-"));
  if (!path.isAbsolute(configuredRoot) || /[\0\r\n,]/.test(configuredRoot) || configuredRoot.split(/[\\/]/).includes("..")) {
    throw new ApiError(503, "隔离验证导出目录配置无效；须使用绝对路径且不得包含特殊分隔符。");
  }
  const root = path.resolve(configuredRoot);
  const parsed = path.parse(root), components = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (!components.length) throw new ApiError(503, "隔离验证导出目录须为专用私有目录，不能使用文件系统根目录。");
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ApiError(503, "隔离验证导出目录不能包含链接或非目录路径。");
  }
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ApiError(503, "隔离验证导出目录不安全。");
  if (process.platform !== "win32" && (entry.mode & 0o777) !== 0o700) throw new ApiError(503, "隔离验证导出目录须使用 0700 私有权限。");
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw new ApiError(503, "隔离验证导出目录必须属于当前服务用户。");
  return mkdtemp(path.join(root, "sf-execution-"));
}

/** Only remove a unique, direct child created by createVerificationSnapshotDirectory. */
export async function removeVerificationSnapshotDirectory(directory: string, parent: string) {
  const root = path.resolve(parent), snapshot = path.resolve(directory);
  if (path.dirname(snapshot) !== root || !/^sf-execution-[A-Za-z0-9]{6}$/.test(path.basename(snapshot))) {
    throw new ApiError(500, "拒绝清理非本任务创建的验证快照目录。");
  }
  const entry = await lstat(snapshot);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ApiError(500, "拒绝清理被替换的验证快照目录。");
  await rm(snapshot, { recursive: true, force: false });
}
/** Run repository code only inside an isolated container, never in the web process. No image pull or dependency install. */
export async function verifyCommand(workspace: WorkspacePort, command: string[], signal: AbortSignal): Promise<Verification> {
  if (!command.length || command.length > 20 || command.some(part => !part || part.length > 1000 || /[\u0000\r\n]/.test(part))) throw new ApiError(400, "验证命令须为 1–20 个有效参数。");
  const view = await workspace.list();
  const unavailable = (output: string): Verification => ({ head: view.head, kind: "command", command, status: "unavailable", output });
  if (workspace.local) return workspace.runCommand ? workspace.runCommand(view.head, command) : unavailable("命令未执行：当前本地 Runner 未提供命令执行能力。");
  const env = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    await exec("docker", ["image", "inspect", "node:24-alpine"], { env, windowsHide: true, timeout: 10000, maxBuffer: 16000, signal });
  } catch {
    signal.throwIfAborted();
    return unavailable("命令未执行：Docker 或本地 node:24-alpine 镜像不可用。文件已保存，可先查看语法检查，稍后准备隔离运行环境再验证。");
  }
  if (view.total > 300) return unavailable("命令未执行：工作区超过 300 个文件的基线限额。");
  const temporary = await createVerificationSnapshotDirectory();
  const directory = path.join(temporary, "workspace");
  const name = `sf-${randomUUID()}`;
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    let size = 0;
    for (const entry of view.files) {
      if (!["100644", "100755"].includes(entry.mode)) continue;
      agentFilePath(entry.path, true);
      const file = await workspace.read(entry.path);
      if (file.head !== view.head) throw new ApiError(409, "准备验证时分支发生变化，请重试。");
      size += Buffer.byteLength(file.content);
      if (size > 4 * 1024 * 1024) return unavailable("命令未执行：验证快照超过 4 MiB。");
      await writeVerificationFile(directory, entry.path, file.content);
    }
    let status: Verification["status"] = "passed", output = "";
    try {
      const result = await exec("docker", containerArguments(name, directory, command), { env, windowsHide: true, timeout: 60000, maxBuffer: 64000, signal });
      output = result.stdout + result.stderr;
    } catch (error) {
      signal.throwIfAborted(); status = "failed";
      const failure = error as { stdout?: string; stderr?: string; killed?: boolean };
      output = `${failure.killed ? "验证超时或输出超限。\n" : "命令未成功完成。\n"}${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    if ((await workspace.list()).head !== view.head) throw new ApiError(409, "命令执行期间分支发生变化，请重新验证。");
    return { head: view.head, kind: "command", command, status, output: output.slice(-12000) || "命令已退出，退出码为 0。" };
  } finally {
    // The container may outlive a killed CLI; remove it before releasing its snapshot.
    await exec("docker", ["rm", "-f", name], { env, windowsHide: true, timeout: 10000, maxBuffer: 1000 }).catch(() => {});
    await removeVerificationSnapshotDirectory(temporary, path.dirname(temporary));
  }
}
