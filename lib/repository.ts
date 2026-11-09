import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors";

const exec = promisify(execFile);
const initialReadme = "# 团队交付仓库\n\n用于验证成员交付、任务分支、差异审查与组长确认合并。\n仅保存主动提交的任务文档，不执行代码，不自动推送到远程仓库。\n";
export function githubRepositoryUrl(value: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(value.trim());
  const repo = match?.[2].replace(/\.git$/, "");
  if (!match || !repo || repo === "." || repo === "..") throw new ApiError(400, "请填写不带凭据或参数的 GitHub HTTPS 仓库地址。");
  return { slug: `${match[1]}/${repo}`, url: `https://github.com/${match[1]}/${repo}.git` };
}

export async function verifyEmptyGitHubRepository(value: string, fetcher: typeof fetch = fetch) {
  const repository = githubRepositoryUrl(value);
  const options = { headers: { Accept: "application/vnd.github+json", "User-Agent": "ScenarioForge" }, redirect: "error" as const, signal: AbortSignal.timeout(15000) };
  const response = await fetcher(`https://api.github.com/repos/${repository.slug}/commits?per_page=1`, options);
  await response.body?.cancel();
  if (response.status === 409) return repository;
  if (response.status === 200) throw new ApiError(409, "该仓库已有提交。请在新项目中使用部署公钥授权并导入。");
  if (response.status === 404) throw new ApiError(400, "未找到可公开读取的仓库；私有仓库认证请通过新项目的部署公钥导入流程完成。");
  throw new ApiError(502, "GitHub 暂时不可访问或已限流，请稍后重试。");
}

export async function connectEmptyGitHubRepository(projectId: string, value: string, fetcher: typeof fetch = fetch) {
  const repository = await verifyEmptyGitHubRepository(value, fetcher);
  await initializeDemoRepository(projectId);
  const cwd = repositoryPath(projectId);
  const current = await git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => "");
  if (current && current !== repository.url) throw new ApiError(409, "此项目已关联其他远程仓库，当前版本不自动替换。");
  if (!current) await git(cwd, ["remote", "add", "origin", repository.url]);
  return repository;
}
const globalGit = globalThis as unknown as { scenarioforgeGitLocks?: Set<string> };
const locks = globalGit.scenarioforgeGitLocks ??= new Set<string>();
// shortcut: one Web process owns these repositories; use a shared operation lock before adding workers.
export async function repositoryOperation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const key = repositoryPath(projectId);
  if (locks.has(key)) throw new ApiError(409, "仓库正在处理另一操作，请稍后重试。");
  locks.add(key);
  try { return await operation(); } finally { locks.delete(key); }
}

function safeId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ApiError(400, "仓库或任务标识无效。");
  return id;
}
function repositoryRoot() { return path.resolve(process.env.SCENARIOFORGE_GIT_ROOT ?? "deploy/private/repositories"); }
export function repositoryPath(projectId: string) { return path.join(repositoryRoot(), safeId(projectId)); }
function taskBranch(taskId: string) { return `task/${safeId(taskId)}`; }
function taskFile(taskId: string) { return `deliveries/${safeId(taskId)}.md`; }

function gitEnvironment() {
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData, TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(repositoryRoot(), "empty-config"), GIT_AUTHOR_NAME: "ScenarioForge", GIT_AUTHOR_EMAIL: "agent@scenarioforge.invalid", GIT_COMMITTER_NAME: "ScenarioForge", GIT_COMMITTER_EMAIL: "agent@scenarioforge.invalid" };
}

export async function repositoryGitBytes(cwd: string, args: string[], options: { sshCommand?: string; indexFile?: string; maxBuffer?: number; authorName?: string; authorEmail?: string } = {}) {
  const { sshCommand } = options;
  // Remote calls receive only this repository's deploy key, never application secrets or credential helpers.
  const { stdout } = await exec("git", ["-c", `core.hooksPath=${path.join(repositoryRoot(), "empty-hooks")}`, "-c", "commit.gpgsign=false", "-c", "credential.helper=", "-c", "protocol.allow=never", ...(sshCommand ? ["-c", "protocol.ssh.allow=always"] : []), ...args], {
    cwd, timeout: sshCommand ? 45000 : 15000, maxBuffer: options.maxBuffer ?? 512000, windowsHide: true, encoding: "buffer",
    env: { ...gitEnvironment(), ...(options.authorName ? { GIT_AUTHOR_NAME: options.authorName, GIT_AUTHOR_EMAIL: options.authorEmail } : {}), ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}), ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: "ssh" } : {}) },
  });
  return stdout;
}

export async function repositoryGit(cwd: string, args: string[], sshCommand?: string) {
  return (await repositoryGitBytes(cwd, args, { sshCommand })).toString("utf8").trimEnd();
}
const git = repositoryGit;

export async function initializeDemoRepository(projectId: string) {
  const destination = repositoryPath(projectId);
  const pending = await importConnection(projectId);
  if (pending && !pending.imported) throw new ApiError(409, "此项目已准备仓库导入，请先完成授权和导入。");
  await mkdir(repositoryRoot(), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repositoryRoot(), "empty-config"), "", { mode: 0o600 });
  await mkdir(path.join(repositoryRoot(), "empty-hooks"), { recursive: true, mode: 0o700 });
  try { await git(destination, ["rev-parse", "--verify", "refs/heads/main"]); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staging = await mkdtemp(path.join(repositoryRoot(), `.init-${safeId(projectId)}-`));
  await git(staging, ["init", "--initial-branch=main"]);
  await writeFile(path.join(staging, "README.md"), initialReadme, { mode: 0o600 });
  await git(staging, ["add", "--", "README.md"]);
  await git(staging, ["commit", "-m", "Initialize team delivery demo"]);
  await rename(staging, destination);
}

export async function repositorySummary(projectId: string) {
  const cwd = repositoryPath(projectId);
  const head = await git(cwd, ["rev-parse", "refs/heads/main"]);
  const remoteUrl = await git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => null);
  const remoteBranch = repositoryBranch(await git(cwd, ["config", "--get", "scenarioforge.remoteBranch"]).catch(() => "main"));
  const files = (await repositoryGitBytes(cwd, ["ls-tree", "-rz", "--name-only", "refs/heads/main"], { maxBuffer: 4 * 1024 * 1024 })).toString("utf8").split("\0").filter(Boolean);
  const refs = (await git(cwd, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/task/"])).split("\n").filter(Boolean).map(line => { const [branch, commit] = line.split(" "); return { taskId: branch.slice(5), branch, commit }; });
  const merged = new Set((await git(cwd, ["for-each-ref", "--merged=refs/heads/main", "--format=%(refname:short)", "refs/heads/task/"])).split("\n"));
  return { head, remoteUrl, remoteBranch, files, branches: refs.map(row => ({ ...row, merged: merged.has(row.branch) })) };
}

export async function storeTaskDelivery(projectId: string, task: { id: string; objective: string; assigneeName: string | null; result: string | null }) {
  if (!task.result || task.result.length > 12000) throw new ApiError(400, "交付内容为空或过长。");
  const cwd = repositoryPath(projectId), branch = taskBranch(task.id), filename = taskFile(task.id);
  const summary = await repositorySummary(projectId);
  const deliveryDirectory = await git(cwd, ["ls-tree", "refs/heads/main", "--", "deliveries"]);
  if (deliveryDirectory && !deliveryDirectory.startsWith("040000 tree ")) throw new ApiError(409, "仓库的 deliveries 路径不是普通目录，请先在仓库中调整后再提交交付。");
  const existing = summary.branches.find(row => row.taskId === task.id);
  const content = `# ${task.objective}\n\n提交成员：${task.assigneeName ?? "成员"}\n\n${task.result}\n`;
  if (existing) {
    const saved = await git(cwd, ["show", `refs/heads/${branch}:${filename}`]).catch(() => null);
    if (saved !== content.trimEnd()) throw new ApiError(409, "任务分支不完整或内容已变化，请管理员检查后再试。");
    return existing.commit;
  }
  if (await git(cwd, ["ls-tree", "refs/heads/main", "--", filename])) throw new ApiError(409, "仓库已包含同名交付文件，不能覆盖。");
  const worktree = path.join(repositoryRoot(), "worktrees", safeId(projectId), safeId(task.id));
  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  await git(cwd, ["worktree", "add", "-b", branch, worktree, "refs/heads/main"]);
  await mkdir(path.join(worktree, "deliveries"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(worktree, filename), content, { mode: 0o600 });
  await git(worktree, ["add", "--", filename]);
  await git(worktree, ["commit", "-m", `Submit task ${task.id}`, "--only", "--", filename]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

export async function reviewTaskDelivery(projectId: string, taskId: string) {
  const cwd = repositoryPath(projectId), branch = taskBranch(taskId);
  const summary = await repositorySummary(projectId);
  const task = summary.branches.find(row => row.taskId === taskId);
  if (!task) throw new ApiError(404, "该任务还未保存到 Git 分支。");
  const diff = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", `refs/heads/main...refs/heads/${branch}`, "--"]);
  return { taskId, head: summary.head, commit: task.commit, merged: task.merged, diff };
}

export async function mergeTaskDelivery(projectId: string, taskId: string, expectedHead: string, expectedCommit: string) {
  const current = await reviewTaskDelivery(projectId, taskId);
  if (current.head !== expectedHead || current.commit !== expectedCommit) throw new ApiError(409, "仓库已有新提交，请重新查看差异后确认。");
  if (current.merged) return current.head;
  const cwd = repositoryPath(projectId), branch = taskBranch(taskId);
  const changed = await git(cwd, ["diff", "--name-only", `refs/heads/main...refs/heads/${branch}`, "--"]);
  if (changed !== taskFile(taskId)) throw new ApiError(409, "分支包含本次交付以外的变更，不能通过演示流程合并。");
  if (await git(cwd, ["status", "--porcelain"])) throw new ApiError(409, "团队工作区有未提交修改，请先处理。");
  await git(cwd, ["merge", "--no-ff", "-m", `Review task ${safeId(taskId)}`, current.commit]);
  return git(cwd, ["rev-parse", "refs/heads/main"]);
}

type RemoteState = { checkedAt: string | null; head: string | null };
function credentialsPath(projectId: string) { return path.join(repositoryRoot(), "credentials", safeId(projectId)); }
type ImportConnection = { url: string; branch: string; imported: boolean; initialHead?: string | null };
export function repositoryBranch(value: string) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(value) || /\.\.|\/\.|\/\/|\.lock(?:\/|$)|[./]$/.test(value) || value === "HEAD") throw new ApiError(400, "分支名无效，请填写 main、master 或 feature/example 这样的分支名。");
  return value;
}
async function importConnection(projectId: string): Promise<ImportConnection | null> {
  const saved = await optionalFile(path.join(credentialsPath(projectId), "connection.json"));
  return saved ? JSON.parse(saved) : null;
}
async function saveImportConnection(projectId: string, connection: ImportConnection) {
  const filename = path.join(credentialsPath(projectId), "connection.json");
  await writeFile(filename + ".tmp", JSON.stringify(connection), { mode: 0o600 });
  await rename(filename + ".tmp", filename);
}
async function repositoryExists(projectId: string) {
  try { await lstat(repositoryPath(projectId)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

// Only an untouched workspace created by this app can be replaced by an import.
// Recheck the exact head immediately before switching and keep the old directory.
async function replaceableInitialHead(projectId: string) {
  if (!await repositoryExists(projectId)) return null;
  const cwd = repositoryPath(projectId), summary = await repositorySummary(projectId);
  const refs = await git(cwd, ["for-each-ref", "--format=%(refname)"]);
  const count = await git(cwd, ["rev-list", "--count", "refs/heads/main"]);
  const clean = !await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const readme = await git(cwd, ["show", "refs/heads/main:README.md"]).catch(() => "");
  const worktrees = await git(cwd, ["worktree", "list", "--porcelain"]);
  if (summary.remoteUrl || refs !== "refs/heads/main" || count !== "1" || !clean || summary.files.join("\n") !== "README.md" || readme !== initialReadme.trimEnd() || worktrees.split("\n").filter(line => line.startsWith("worktree ")).length !== 1) {
    throw new ApiError(409, "此工作区已有提交、交付或仓库连接，不能覆盖。请使用新项目导入，或继续管理当前仓库。");
  }
  return summary.head;
}

export async function prepareRepositoryImport(projectId: string, value: string, selectedBranch = "") {
  const repository = githubRepositoryUrl(value);
  const branch = selectedBranch.trim() ? repositoryBranch(selectedBranch.trim()) : "";
  const initialHead = await replaceableInitialHead(projectId);
  await mkdir(repositoryRoot(), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repositoryRoot(), "empty-config"), "", { mode: 0o600 });
  await mkdir(path.join(repositoryRoot(), "empty-hooks"), { recursive: true, mode: 0o700 });
  const directory = credentialsPath(projectId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await importConnection(projectId);
  if (previous && previous.url !== repository.url) throw new ApiError(409, "此项目已准备其他仓库的授权，请新建项目连接其他仓库。");
  await saveImportConnection(projectId, { url: repository.url, branch, imported: false, initialHead });
  await createRepositoryDeployKey(projectId);
  return repositoryRemoteStatus(projectId, true);
}

// Fetch into a separate directory so failed imports never replace an existing workspace.
// The injectable transport is used only by tests with local fixture remotes.
export async function importGitHubRepository(projectId: string, run: typeof git = git) {
  const connection = await importConnection(projectId);
  if (!connection || !(await repositoryRemoteStatus(projectId)).configured) throw new ApiError(409, "请先填写仓库地址并生成部署公钥。");
  const repository = githubRepositoryUrl(connection.url);
  if (await repositoryExists(projectId)) {
    const summary = await repositorySummary(projectId);
    const marker = await git(repositoryPath(projectId), ["config", "--get", "scenarioforge.imported"]).catch(() => "");
    if (marker === "true" && summary.remoteUrl === repository.url) {
      await saveImportConnection(projectId, { ...connection, branch: summary.remoteBranch, imported: true });
      return summary;
    }
    if (!connection.initialHead || await replaceableInitialHead(projectId) !== connection.initialHead) throw new ApiError(409, "工作区在准备导入后发生变化，请重新保存连接配置；已有内容不会被覆盖。");
  }
  let staging: string | undefined;
  try {
    const url = "ssh://git@ssh.github.com:443/" + repository.slug + ".git", ssh = githubSshCommand(projectId);
    const refs = await run(repositoryRoot(), ["ls-remote", "--symref", url, "HEAD", "refs/heads/*"], ssh);
    const branches = new Map<string, string>();
    let defaultBranch = "";
    for (const line of refs.split("\n").filter(Boolean)) {
      const symbolic = /^ref: refs\/heads\/(.+)\s+HEAD$/.exec(line);
      const branchRef = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(line);
      if (symbolic) defaultBranch = symbolic[1];
      else if (branchRef) branches.set(branchRef[2], branchRef[1]);
      else if (!/^[a-f0-9]{40}\s+HEAD$/.test(line)) throw new ApiError(502, "无法识别远程分支信息，请检查仓库后重试。");
    }
    const branch = repositoryBranch(connection.branch || defaultBranch || (branches.size ? "" : "main"));
    const head = branches.get(branch);
    if (branches.size && !head) throw new ApiError(400, "仓库中没有该分支，请填写已有分支名后重新保存。");
    staging = await mkdtemp(path.join(repositoryRoot(), `.import-${safeId(projectId)}-`));
    await git(staging, ["init", "--initial-branch=main"]);
    if (head) {
      await run(staging, ["fetch", "--no-tags", "--no-recurse-submodules", url, `refs/heads/${branch}:refs/remotes/origin/${branch}`], ssh);
      const fetched = await git(staging, ["rev-parse", `refs/remotes/origin/${branch}`]);
      if (fetched !== head) throw new ApiError(409, "远程分支在导入时更新了，请重新导入。");
      await git(staging, ["checkout", "-B", "main", head]);
    } else {
      await writeFile(path.join(staging, "README.md"), "# 团队交付仓库\n\n用于团队文档交付和审查。\n", { mode: 0o600 });
      await git(staging, ["add", "--", "README.md"]);
      await git(staging, ["commit", "-m", "Initialize team repository"]);
    }
    await git(staging, ["remote", "add", "origin", repository.url]);
    await git(staging, ["config", "scenarioforge.remoteBranch", branch]);
    await git(staging, ["config", "scenarioforge.imported", "true"]);
    let backup: string | undefined;
    if (await repositoryExists(projectId)) {
      if (!connection.initialHead || await replaceableInitialHead(projectId) !== connection.initialHead) throw new ApiError(409, "工作区在导入时发生变化，已停止切换。请重新检查项目。");
      const backups = path.join(repositoryRoot(), "backups", safeId(projectId));
      await mkdir(backups, { recursive: true, mode: 0o700 });
      const container = await mkdtemp(path.join(backups, "before-import-"));
      backup = path.join(container, "repository");
      await rename(repositoryPath(projectId), backup);
    }
    try { await rename(staging, repositoryPath(projectId)); }
    catch (error) {
      if (backup && !await repositoryExists(projectId)) await rename(backup, repositoryPath(projectId));
      throw error;
    }
    staging = undefined;
    await saveImportConnection(projectId, { url: repository.url, branch, imported: true });
    await saveRemoteState(projectId, head ?? null);
    return await repositorySummary(projectId);
  } catch (error) { remoteError(error); }
  finally {
    if (staging) {
      const resolved = path.resolve(staging), root = repositoryRoot();
      if (path.dirname(resolved) === root && path.basename(resolved).startsWith(`.import-${safeId(projectId)}-`)) await rm(resolved, { recursive: true, force: true });
    }
  }
}
async function optionalFile(filename: string) {
  try { return await readFile(filename, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function repositoryRemoteStatus(projectId: string, includePublicKey = false) {
  const directory = credentialsPath(projectId);
  const publicKey = await optionalFile(path.join(directory, "id_ed25519.pub"));
  const saved = await optionalFile(path.join(directory, "remote.json"));
  const state: RemoteState = saved ? JSON.parse(saved) : { checkedAt: null, head: null };
  const connection = await importConnection(projectId);
  return { configured: Boolean(publicKey), ...(includePublicKey && publicKey ? { publicKey: publicKey.trim() } : {}), ...state, ...(connection ? { connection } : {}) };
}

export async function createRepositoryDeployKey(projectId: string) {
  const connection = await importConnection(projectId);
  const url = connection?.url ?? (await repositorySummary(projectId)).remoteUrl;
  if (!url) throw new ApiError(409, "请先关联 GitHub 仓库。");
  githubRepositoryUrl(url);
  const directory = credentialsPath(projectId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const publicKey = await optionalFile(path.join(directory, "id_ed25519.pub"));
  // GitHub official /meta SSH Ed25519 host key, verified 2026-11-08; rotation must be verified before replacement.
  await writeFile(path.join(directory, "known_hosts"), "[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n", { mode: 0o600 });
  if (publicKey) return repositoryRemoteStatus(projectId, true);
  try {
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "ScenarioForge-" + safeId(projectId), "-f", path.join(directory, "id_ed25519")], { env: gitEnvironment(), timeout: 10000, windowsHide: true });
  } catch { throw new ApiError(500, "无法创建仓库部署密钥，请管理员检查 SSH 工具和私有目录。已有密钥不会自动覆盖。"); }
  await chmod(path.join(directory, "id_ed25519"), 0o600);
  return repositoryRemoteStatus(projectId, true);
}

export function githubSshCommand(projectId: string) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const directory = credentialsPath(projectId);
  return "ssh -F " + quote(path.join(repositoryRoot(), "empty-config")) + " -i " + quote(path.join(directory, "id_ed25519")) + " -o UserKnownHostsFile=" + quote(path.join(directory, "known_hosts")) + " -o GlobalKnownHostsFile=" + quote(path.join(repositoryRoot(), "empty-config")) + " -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o HostKeyAlgorithms=ssh-ed25519 -o ServerAliveInterval=10 -o ServerAliveCountMax=2";
}

function remoteError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const detail = String((error as { stderr?: string }).stderr ?? "");
  if (/Permission denied|access denied|Repository not found/i.test(detail)) throw new ApiError(502, "GitHub 尚未授权此部署密钥，或没有仓库写权限。请检查 Deploy keys 和 Allow write access。");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(detail)) throw new ApiError(502, "GitHub 主机密钥校验失败，连接已停止，请管理员核验官方主机密钥。");
  if (/rejected|fetch first|non-fast-forward|GH006|GH013|protected branch/i.test(detail)) throw new ApiError(409, "GitHub 拒绝推送：远程已有新提交或分支规则不允许。请重新检查远程；不会强制覆盖。");
  throw new ApiError(502, "GitHub SSH 连接或操作未完成，请检查网络后重试。若刚才正在推送，请先检查远程状态，避免误判结果。");
}

async function remoteConnection(projectId: string) {
  const summary = await repositorySummary(projectId);
  if (!summary.remoteUrl || !(await repositoryRemoteStatus(projectId)).configured) throw new ApiError(409, "请先关联仓库并创建部署密钥。");
  const repository = githubRepositoryUrl(summary.remoteUrl);
  return { summary, cwd: repositoryPath(projectId), url: "ssh://git@ssh.github.com:443/" + repository.slug + ".git", ssh: githubSshCommand(projectId) };
}

async function readRemoteHead(connection: Awaited<ReturnType<typeof remoteConnection>>, run: typeof git) {
  const ref = `refs/heads/${connection.summary.remoteBranch}`;
  const refs = await run(connection.cwd, ["ls-remote", "--refs", connection.url, ref], connection.ssh);
  if (!refs.trim()) return null;
  const match = /^([a-f0-9]{40})\s+(refs\/heads\/.+)$/.exec(refs.trim());
  if (!match || match[2] !== ref) throw new ApiError(502, "GitHub 返回了无法识别的分支信息，已停止操作。");
  return match[1];
}

async function saveRemoteState(projectId: string, head: string | null) {
  const state: RemoteState = { checkedAt: new Date().toISOString(), head };
  const directory = credentialsPath(projectId);
  await writeFile(path.join(directory, "remote.json.tmp"), JSON.stringify(state), { mode: 0o600 });
  await rename(path.join(directory, "remote.json.tmp"), path.join(directory, "remote.json"));
  return state;
}

export async function checkRepositoryRemote(projectId: string, run: typeof git = git) {
  try {
    const connection = await remoteConnection(projectId);
    return await saveRemoteState(projectId, await readRemoteHead(connection, run));
  } catch (error) { remoteError(error); }
}

export async function pushRepositoryMain(projectId: string, expectedHead: string, expectedRemote: string | null, run: typeof git = git) {
  try {
    if (!/^[a-f0-9]{40}$/.test(expectedHead) || (expectedRemote !== null && !/^[a-f0-9]{40}$/.test(expectedRemote))) throw new ApiError(400, "提交标识无效。");
    const connection = await remoteConnection(projectId);
    if (connection.summary.head !== expectedHead) throw new ApiError(409, "本地 main 已改变，请刷新并重新确认推送内容。");
    if (await git(connection.cwd, ["status", "--porcelain"])) throw new ApiError(409, "团队工作区有未提交修改，请先处理。");
    const remoteHead = await readRemoteHead(connection, run);
    if (remoteHead !== expectedRemote) throw new ApiError(409, `远程 ${connection.summary.remoteBranch} 已改变，请重新检查远程后再操作。`);
    if (remoteHead === expectedHead) return await saveRemoteState(projectId, remoteHead);
    // Only advance main normally; Git rejects divergence and races without force or branch deletion.
    await run(connection.cwd, ["push", "--porcelain", connection.url, expectedHead + ":refs/heads/" + connection.summary.remoteBranch], connection.ssh);
    const confirmed = await readRemoteHead(connection, run);
    if (confirmed !== expectedHead) throw new ApiError(409, "推送后远程状态发生变化，请检查远程；不会自动重试或覆盖。");
    return await saveRemoteState(projectId, confirmed);
  } catch (error) { remoteError(error); }
}

// Pull only advances main. A divergence must be resolved deliberately in a Git client.
export async function pullRepositoryMain(projectId: string, expectedHead: string, expectedRemote: string, run: typeof git = git) {
  try {
    if (!/^[a-f0-9]{40}$/.test(expectedHead) || !/^[a-f0-9]{40}$/.test(expectedRemote)) throw new ApiError(400, "提交标识无效。");
    const connection = await remoteConnection(projectId);
    if (connection.summary.head !== expectedHead) throw new ApiError(409, "本地 main 已改变，请刷新后重新拉取。");
    if (await git(connection.cwd, ["symbolic-ref", "HEAD"]) !== "refs/heads/main" || await git(connection.cwd, ["status", "--porcelain"])) throw new ApiError(409, "团队工作区状态异常或有未提交修改，请先处理。");
    if (await readRemoteHead(connection, run) !== expectedRemote) throw new ApiError(409, "远程分支已改变，请重新检查 GitHub 连接。");
    await run(connection.cwd, ["fetch", "--no-tags", "--no-recurse-submodules", connection.url, `refs/heads/${connection.summary.remoteBranch}`], connection.ssh);
    const fetched = await git(connection.cwd, ["rev-parse", "FETCH_HEAD"]);
    if (fetched !== expectedRemote) throw new ApiError(409, "远程在拉取期间发生变化，请重新检查后再拉取。");
    const behind = await git(connection.cwd, ["merge-base", "--is-ancestor", expectedHead, fetched]).then(() => true, () => false);
    const ahead = await git(connection.cwd, ["merge-base", "--is-ancestor", fetched, expectedHead]).then(() => true, () => false);
    if (!behind && !ahead) throw new ApiError(409, "本地和远程都有独立提交，无法快进拉取。请在 Git 客户端合并后再同步；本地内容已保留。");
    if (behind && expectedHead !== fetched) await git(connection.cwd, ["merge", "--ff-only", fetched]);
    return await saveRemoteState(projectId, fetched);
  } catch (error) { remoteError(error); }
}
