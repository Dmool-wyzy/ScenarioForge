import "server-only";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors";
import { repositoryBranch, repositoryGit as git, repositoryGitBytes as bytes, repositoryPath } from "./repository";

export const FILE_LIMIT = 1024 * 1024;
export const BATCH_LIMIT = 4 * FILE_LIMIT;
export type RepositoryActor = { id: string; username: string; owner: boolean };
export type RepositoryChange = { path: string; content?: string; encoding?: "utf8" | "base64"; delete?: boolean };
type Entry = { path: string; mode: string; type: string; oid: string; size: number };

export function repositoryFilePath(value: string) {
  if (!value || value.length > 500 || /[\\\u0000-\u001f\u007f:*?"<>|]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ApiError(400, "文件路径无效，请使用仓库内的相对路径，例如 src/main.ts。");
  return value;
}
function userPrefix(actor: RepositoryActor) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(actor.id)) throw new ApiError(400, "成员标识无效。");
  return `work/${actor.id}/`;
}
export function canEditRepositoryBranch(branch: string, actor: RepositoryActor) {
  return branch.startsWith("work/") && (actor.owner || branch.startsWith(userPrefix(actor)));
}
export function assertRepositoryBranchWrite(branch: string, actor: RepositoryActor) {
  repositoryBranch(branch);
  if (!canEditRepositoryBranch(branch, actor)) throw new ApiError(403, "请在自己的工作分支中提交文件；main 和任务交付分支不能直接编辑。");
}
async function headOf(projectId: string, branch: string) {
  return git(repositoryPath(projectId), ["rev-parse", "--verify", `refs/heads/${repositoryBranch(branch)}`]).catch(() => { throw new ApiError(404, "分支不存在，请刷新仓库。"); });
}
async function expectHead(projectId: string, branch: string, expected: string) {
  const head = await headOf(projectId, branch);
  if (!/^[a-f0-9]{40}$/.test(expected) || head !== expected) throw new ApiError(409, "分支已有新提交，请先保存草稿并刷新，然后重新查看差异。");
  return head;
}
async function entriesAt(projectId: string, head: string): Promise<Entry[]> {
  let raw: Buffer;
  try { raw = await bytes(repositoryPath(projectId), ["ls-tree", "-rlz", head], { maxBuffer: 4 * FILE_LIMIT }); }
  catch { throw new ApiError(413, "仓库文件列表过大，请使用 Git 客户端浏览。"); }
  const entries = raw.toString("utf8").split("\0").filter(Boolean).map(record => {
    const tab = record.indexOf("\t"), [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
    return { path: record.slice(tab + 1), mode, type, oid, size: Number(size) || 0 };
  });
  if (entries.length > 10000) throw new ApiError(413, "网页工作区最多浏览 10000 个文件，请使用 Git 客户端处理大型仓库。");
  return entries;
}
function ordinary(entry: Entry) { return entry.type === "blob" && ["100644", "100755"].includes(entry.mode); }

export async function repositoryWorkspace(projectId: string, branch: string, actor: RepositoryActor) {
  const cwd = repositoryPath(projectId), head = await headOf(projectId, branch);
  const merged = new Set((await git(cwd, ["for-each-ref", "--merged=refs/heads/main", "--format=%(refname:short)", "refs/heads/"])).split("\n"));
  const branches = (await git(cwd, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"])).split("\n").filter(Boolean).map(line => {
    const [name, commit] = line.split(" ");
    return { name, head: commit, editable: canEditRepositoryBranch(name, actor), merged: merged.has(name) };
  });
  const [ahead, behind] = (await git(cwd, ["rev-list", "--left-right", "--count", `${head}...refs/heads/main`])).split(/\s+/).map(Number);
  return { branch, head, branches, files: await entriesAt(projectId, head), editable: canEditRepositoryBranch(branch, actor), prefix: userPrefix(actor), ahead, behind };
}

export async function repositoryFile(projectId: string, branch: string, filename: string) {
  const head = await headOf(projectId, branch), selected = repositoryFilePath(filename);
  const entry = (await entriesAt(projectId, head)).find(item => item.path === selected);
  if (!entry) throw new ApiError(404, "文件不存在。");
  if (!ordinary(entry)) return { ...entry, head, text: null, base64: null, reason: "符号链接和子模块只显示引用，不读取目标内容。" };
  if (entry.size > FILE_LIMIT) return { ...entry, head, text: null, base64: null, reason: "文件超过 1 MiB，请在 Git 客户端读取。" };
  const content = await bytes(repositoryPath(projectId), ["cat-file", "blob", entry.oid], { maxBuffer: FILE_LIMIT + 100 });
  let text: string | null = null;
  try { const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); if (!decoded.includes("\0")) text = decoded; } catch { /* Binary files remain downloadable. */ }
  return { ...entry, head, text, base64: content.toString("base64"), reason: text === null ? "二进制文件，可下载原文件。" : null };
}

export async function createRepositoryBranch(projectId: string, actor: RepositoryActor, name: string, from: string, expected: string) {
  const branch = repositoryBranch(userPrefix(actor) + repositoryBranch(name));
  const head = await expectHead(projectId, from, expected);
  await git(repositoryPath(projectId), ["update-ref", `refs/heads/${branch}`, head, "0".repeat(40)]).catch(() => { throw new ApiError(409, "分支名已存在，请使用其他名称。"); });
  return { branch };
}

export async function commitRepositoryFiles(projectId: string, actor: RepositoryActor, branch: string, expected: string, message: string, changes: RepositoryChange[]) {
  assertRepositoryBranchWrite(branch, actor);
  const head = await expectHead(projectId, branch, expected), cwd = repositoryPath(projectId);
  const title = message.trim();
  if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new ApiError(400, "请填写 1–200 字的单行提交说明。");
  if (!changes.length || changes.length > 50) throw new ApiError(400, "每次提交需要包含 1–50 个文件变更。");
  const entries = await entriesAt(projectId, head), existing = new Map(entries.map(entry => [entry.path, entry]));
  const seen = new Set<string>(); let total = 0;
  const validated = changes.map(change => {
    const filename = repositoryFilePath(change.path), key = filename.toLowerCase();
    if (seen.has(key)) throw new ApiError(400, "同次提交不能重复修改同一路径（包括大小写不同的路径）。");
    seen.add(key);
    const original = existing.get(filename);
    if (original && !ordinary(original)) throw new ApiError(400, "不能通过网页修改符号链接或子模块。");
    if (change.delete) {
      if (!original || change.content !== undefined) throw new ApiError(400, "待删除文件不存在或删除参数无效。");
      return { path: filename, delete: true, content: Buffer.alloc(0), mode: "100644" };
    }
    if (typeof change.content !== "string") throw new ApiError(400, "文件内容不能为空参数。");
    if (change.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(change.content)) throw new ApiError(400, "上传文件编码无效。");
    const content = Buffer.from(change.content, change.encoding === "base64" ? "base64" : "utf8");
    total += content.length;
    if (content.length > FILE_LIMIT || total > BATCH_LIMIT) throw new ApiError(413, "单个文件最多 1 MiB，每次提交文件总大小最多 4 MiB。");
    return { path: filename, delete: false, content, mode: original?.mode ?? "100644" };
  });
  const finalPaths = [...entries.filter(entry => !validated.some(change => change.path === entry.path)).map(entry => entry.path), ...validated.filter(change => !change.delete).map(change => change.path)];
  const lower = new Set<string>();
  for (const filename of finalPaths) {
    const key = filename.toLowerCase();
    if (lower.has(key)) throw new ApiError(409, "存在仅大小写不同的文件路径，请在 Git 客户端处理。");
    lower.add(key);
  }
  for (const filename of finalPaths) {
    const parts = filename.toLowerCase().split("/"); parts.pop();
    while (parts.length) { if (lower.has(parts.join("/"))) throw new ApiError(409, "路径与已有文件、符号链接或子模块冲突。"); parts.pop(); }
  }
  // A private temporary index creates one atomic commit without changing the shared checkout.
  const temporary = await mkdtemp(path.join(path.dirname(cwd), ".edit-"));
  const indexFile = path.join(temporary, "index");
  const indexed = async (args: string[]) => (await bytes(cwd, args, { indexFile })).toString("utf8").trimEnd();
  try {
    await indexed(["read-tree", head]);
    for (const change of validated.filter(item => item.delete)) await indexed(["update-index", "--force-remove", "--", change.path]);
    for (const change of validated.filter(item => !item.delete)) {
      const blobFile = path.join(temporary, "blob");
      await writeFile(blobFile, change.content, { mode: 0o600 });
      const oid = await git(cwd, ["hash-object", "-w", "--no-filters", "--", blobFile]);
      await indexed(["update-index", "--add", "--cacheinfo", change.mode, oid, change.path]);
    }
    const tree = await indexed(["write-tree"]);
    if (tree === await git(cwd, ["rev-parse", `${head}^{tree}`])) throw new ApiError(400, "内容没有变化，无需创建提交。");
    const author = actor.username.replace(/[\u0000-\u001f\u007f<>]/g, "").slice(0, 100) || "成员";
    const commit = (await bytes(cwd, ["commit-tree", tree, "-p", head, "-m", `${title}\n\nSubmitted-by: ${author} (${actor.id})`], { authorName: author, authorEmail: `${actor.id}@members.scenarioforge.invalid` })).toString("utf8").trim();
    await git(cwd, ["update-ref", `refs/heads/${branch}`, commit, head]).catch(() => { throw new ApiError(409, "分支已更新，本次内容未覆盖他人提交。请刷新后重新提交。"); });
    return { commit };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function limitedDiff(cwd: string, args: string[]) {
  try { return { diff: await git(cwd, args), truncated: false }; }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { diff: "差异超过网页显示上限，请在 Git 客户端审查后合并。", truncated: true };
    throw error;
  }
}
export async function compareRepositoryBranch(projectId: string, branch: string) {
  const cwd = repositoryPath(projectId), commit = await headOf(projectId, branch), head = await headOf(projectId, "main");
  const merged = await git(cwd, ["merge-base", "--is-ancestor", commit, head]).then(() => true, () => false);
  return { branch, head, commit, merged, ...await limitedDiff(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", `${head}...${commit}`, "--"]) };
}
export async function mergeRepositoryBranch(projectId: string, branch: string, expectedHead: string, expectedCommit: string) {
  if (!branch.startsWith("work/")) throw new ApiError(400, "请选择工作分支，任务交付请使用交付审查入口。");
  await expectHead(projectId, "main", expectedHead); await expectHead(projectId, branch, expectedCommit);
  const review = await compareRepositoryBranch(projectId, branch);
  if (review.merged) return { commit: review.head };
  if (review.truncated) throw new ApiError(413, "差异过大，请在 Git 客户端审查和合并。");
  const cwd = repositoryPath(projectId);
  if (await git(cwd, ["symbolic-ref", "HEAD"]) !== "refs/heads/main" || await git(cwd, ["status", "--porcelain"])) throw new ApiError(409, "主工作区有未提交修改或状态异常，请先处理。");
  try { await git(cwd, ["merge", "--no-ff", "-m", `Merge reviewed branch ${branch}`, expectedCommit]); }
  catch {
    const inMerge = await git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
    if (inMerge) await git(cwd, ["merge", "--abort"]);
    throw new ApiError(409, "分支无法自动合并（可能存在冲突）。main 已保留，请在 Git 客户端解决冲突后再提交。");
  }
  return { commit: await headOf(projectId, "main") };
}
export async function deleteRepositoryBranch(projectId: string, branch: string, expected: string, actor: RepositoryActor) {
  assertRepositoryBranchWrite(branch, actor);
  const commit = await expectHead(projectId, branch, expected), cwd = repositoryPath(projectId);
  const merged = await git(cwd, ["merge-base", "--is-ancestor", commit, "refs/heads/main"]).then(() => true, () => false);
  if (!merged) throw new ApiError(409, "该分支还有未合并的提交，请先合并后再删除。");
  await git(cwd, ["update-ref", "-d", `refs/heads/${branch}`, commit]);
  return { ok: true };
}
export async function repositoryHistory(projectId: string, branch: string, skip = 0) {
  const head = await headOf(projectId, branch);
  if (!Number.isInteger(skip) || skip < 0 || skip > 10000) throw new ApiError(400, "页码无效。");
  const raw = await git(repositoryPath(projectId), ["log", "-26", `--skip=${skip}`, "--format=%H%x00%an%x00%aI%x00%s%x00", head, "--"]);
  const fields = raw.split("\0"), rows = [];
  for (let i = 0; i + 3 < fields.length; i += 4) rows.push({ commit: fields[i].trim(), author: fields[i + 1], date: fields[i + 2], subject: fields[i + 3] });
  return { head, commits: rows.slice(0, 25), more: rows.length > 25 };
}
export async function repositoryCommitDetail(projectId: string, branch: string, commit: string) {
  const head = await headOf(projectId, branch), cwd = repositoryPath(projectId);
  if (!/^[a-f0-9]{40}$/.test(commit) || !await git(cwd, ["merge-base", "--is-ancestor", commit, head]).then(() => true, () => false)) throw new ApiError(404, "当前分支不包含该提交。");
  return { commit, ...await limitedDiff(cwd, ["show", "--format=fuller", "--first-parent", "--no-ext-diff", "--no-textconv", "--stat", "--patch", commit, "--"]) };
}
