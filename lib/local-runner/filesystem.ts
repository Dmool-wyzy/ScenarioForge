import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export const LOCAL_FILE_LIMIT = 300;
export const LOCAL_FILE_CHAR_LIMIT = 40_000;

export type LocalFileInfo = { path: string; size: number; mode: "100644" | "100755" };
export type LocalWorkspaceView = { executionId: string; head: string; files: LocalFileInfo[]; total: number };
export type LocalChange = { path: string; content: string } | { path: string; delete: true };
export type LocalDiffFile = { path: string; status: "added" | "modified" | "deleted"; before: string | null; after: string | null };
export type LocalWorkspaceDiff = { baseHead: string; head: string; changedPaths: string[]; files: LocalDiffFile[] };

type FileRecord = { content: string; hash: string; mode: "100644" | "100755" };
type ExecutionState = { root: string; baselineHead: string; baseline: Map<string, FileRecord> };

const executions = new Map<string, ExecutionState>();
const locks = new Map<string, Promise<void>>();
const tempName = /^\.scenarioforge-local-tmp-[a-f0-9]{32}$/;
const ignoredParts = new Set([".git", "node_modules", ".ssh", ".aws", ".venv", ".scenarioforge", ".next", ".tmp", ".cache", ".turbo", "dist", "build", "coverage"]);

class LocalWorkspaceError extends Error {
  override name = "LocalWorkspaceError";
}
function problem(message: string) { return new LocalWorkspaceError(message); }

function validExecutionId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw problem("Invalid local execution id.");
}

function validRelativePath(value: string) {
  if (!value || value.length > 500 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f:*?"<>|]/.test(value)) {
    throw problem("Invalid workspace-relative path.");
  }
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw problem("Invalid workspace-relative path.");
  }
  if (isExcludedPath(value)) throw problem("This path is excluded from local Agent access.");
  return parts;
}

function isExcludedPath(value: string) {
  const parts = value.split("/");
  if (parts.some(part => ignoredParts.has(part.toLowerCase()) || tempName.test(part))) return true;
  if (parts.some(part => /^\.env(?:\.|$)/i.test(part) && !/\.(example|sample|template)$/i.test(part))) return true;
  if (parts.some(part => /^(id_rsa|id_ed25519)$/i.test(part) || /\.(pem|key|p12|pfx)$/i.test(part))) return true;
  return false;
}

function withinRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveChild(root: string, relativePath: string) {
  const parts = validRelativePath(relativePath);
  const target = path.resolve(root, ...parts);
  if (!withinRoot(root, target)) throw problem("Workspace path escaped its selected root.");
  return { parts, target };
}

async function withLock<T>(executionId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(executionId) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  locks.set(executionId, current);
  await previous;
  try { return await action(); }
  catch (error) {
    if (error instanceof LocalWorkspaceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw problem(code && /^[A-Z0-9_]+$/.test(code) ? `Local filesystem operation failed (${code}).` : "Local filesystem operation failed.");
  }
  finally {
    unlock();
    if (locks.get(executionId) === current) locks.delete(executionId);
  }
}

async function requireState(executionId: string) {
  validExecutionId(executionId);
  const state = executions.get(executionId);
  if (!state) throw problem("Local workspace snapshot is unavailable; start the execution again.");
  const currentRoot = await realpath(state.root);
  if (currentRoot !== state.root) throw problem("The selected workspace root changed during execution.");
  return state;
}

function headOf(files: Map<string, FileRecord>) {
  const hash = createHash("sha1");
  for (const [filename, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(filename).update("\0").update(file.mode).update("\0").update(file.hash).update("\n");
  }
  return hash.digest("hex");
}

function viewOf(executionId: string, files: Map<string, FileRecord>): LocalWorkspaceView {
  const entries: LocalFileInfo[] = [...files].sort(([left], [right]) => left.localeCompare(right)).map(([filename, file]) => ({
    path: filename, size: Buffer.byteLength(file.content), mode: file.mode,
  }));
  return { executionId, head: headOf(files), files: entries, total: entries.length };
}

function decodeText(bytes: Buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

async function assertPathComponents(root: string, parts: string[], includeLeaf: boolean) {
  let cursor = root;
  const limit = includeLeaf ? parts.length : parts.length - 1;
  for (let index = 0; index < limit; index++) {
    cursor = path.join(cursor, parts[index]);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw problem("Symbolic links are not accessible in the local workspace.");
      if (index < parts.length - 1 && !entry.isDirectory()) throw problem("A workspace parent path is not a directory.");
      if (index === parts.length - 1 && includeLeaf && !entry.isFile()) throw problem("Only regular files are accessible in the local workspace.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readSafeFile(root: string, filename: string) {
  const { parts, target } = resolveChild(root, filename);
  await assertPathComponents(root, parts, true);
  const canonical = await realpath(target);
  if (!withinRoot(root, canonical)) throw problem("Workspace path escaped its selected root.");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw problem("Only regular files are accessible in the local workspace.");
    if (info.size > LOCAL_FILE_CHAR_LIMIT * 4) return null;
    const bytes = await handle.readFile();
    const content = decodeText(bytes);
    if (content === null || content.includes("\0")) return null;
    if (content.length > LOCAL_FILE_CHAR_LIMIT) return null;
    return { content, mode: (info.mode & 0o111) ? "100755" as const : "100644" as const };
  } finally { await handle.close(); }
}

async function scan(root: string) {
  const files = new Map<string, FileRecord>();
  const visit = async (directory: string, prefix: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedPath(relativeName)) continue;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const canonical = await realpath(absolute);
        if (!withinRoot(root, canonical)) continue;
        await visit(absolute, relativeName);
        continue;
      }
      if (!info.isFile()) continue;
      const file = await readSafeFile(root, relativeName);
      if (!file) continue;
      files.set(relativeName, { ...file, hash: createHash("sha256").update(file.content, "utf8").digest("hex") });
      if (files.size > LOCAL_FILE_LIMIT) throw problem(`Workspace exceeds the ${LOCAL_FILE_LIMIT}-file local execution limit.`);
    }
  };
  await visit(root, "");
  return files;
}

function assertHead(files: Map<string, FileRecord>, expectedHead?: string) {
  const actual = headOf(files);
  if (expectedHead !== undefined && actual !== expectedHead) throw problem("Workspace changed since the last snapshot; refresh before continuing.");
  return actual;
}

async function inspectTarget(root: string, filename: string) {
  const { parts, target } = resolveChild(root, filename);
  await assertPathComponents(root, parts, false);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw problem("Symbolic links are not accessible in the local workspace.");
    if (!info.isFile()) throw problem("Only regular files are accessible in the local workspace.");
    return { exists: true as const, target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false as const, target };
    throw error;
  }
}

async function ensureParents(root: string, parts: string[]) {
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    try { await mkdir(cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw problem("A workspace parent path is unsafe.");
    const canonical = await realpath(cursor);
    if (!withinRoot(root, canonical)) throw problem("Workspace path escaped its selected root.");
  }
}

/** Capture an immutable baseline in this Runner process. The absolute root remains local. */
export async function snapshotWorkspace(rootPath: string, executionId: string): Promise<LocalWorkspaceView> {
  validExecutionId(executionId);
  return withLock(executionId, async () => {
    if (executions.has(executionId)) throw problem("A local snapshot already exists for this execution.");
    const root = await realpath(path.resolve(rootPath));
    if (!(await lstat(root)).isDirectory()) throw problem("The selected workspace root must be a directory.");
    const files = await scan(root);
    const head = headOf(files);
    executions.set(executionId, { root, baselineHead: head, baseline: new Map(files) });
    return viewOf(executionId, files);
  });
}

export async function listWorkspace(executionId: string, query = "", expectedHead?: string): Promise<LocalWorkspaceView> {
  return withLock(executionId, async () => {
    const state = await requireState(executionId), files = await scan(state.root);
    assertHead(files, expectedHead);
    const view = viewOf(executionId, files);
    return query ? { ...view, files: view.files.filter(file => file.path.includes(query)), total: view.files.filter(file => file.path.includes(query)).length } : view;
  });
}

export async function readWorkspace(executionId: string, filename: string, expectedHead?: string) {
  return withLock(executionId, async () => {
    const parts = validRelativePath(filename), state = await requireState(executionId);
    await assertPathComponents(state.root, parts, true);
    const files = await scan(state.root), head = assertHead(files, expectedHead);
    const file = files.get(filename);
    if (!file) throw problem("File is missing or is not an accessible UTF-8 text file.");
    return { path: filename, head, content: file.content };
  });
}

/** Inspect only the paths already changed by this task, with one consistent tree version. */
export async function inspectWorkspace(executionId: string, paths: string[]) {
  return withLock(executionId, async () => {
    if (!Array.isArray(paths) || paths.length > 300) throw problem("Invalid inspection paths.");
    const state = await requireState(executionId), files = await scan(state.root);
    const head = headOf(files), entries: { path: string; content: string | null }[] = [];
    for (const filename of paths) {
      validRelativePath(filename);
      const target = await inspectTarget(state.root, filename);
      if (target.exists && !files.has(filename)) throw problem("A changed file is no longer accessible text.");
      entries.push({ path: filename, content: files.get(filename)?.content ?? null });
    }
    assertHead(await scan(state.root), head);
    return { head, entries };
  });
}

export async function writeWorkspace(executionId: string, expectedHead: string, changes: LocalChange[], receiptBudget = 1_000_000) {
  return withLock(executionId, async () => {
    if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw problem("Invalid workspace tree head.");
    if (!Array.isArray(changes) || !changes.length || changes.length > 20) throw problem("A write must contain between 1 and 20 file changes.");
    const state = await requireState(executionId), baseline = await scan(state.root);
    assertHead(baseline, expectedHead);
    const seen = new Set<string>();
    for (const change of changes) {
      if (!change || typeof change !== "object" || typeof change.path !== "string" ||
          ("content" in change ? typeof change.content !== "string" || "delete" in change : !("delete" in change) || change.delete !== true)) {
        throw problem("A file change must contain UTF-8 text or request deletion.");
      }
      validRelativePath(change.path);
      const key = process.platform === "win32" ? change.path.toLowerCase() : change.path;
      if (seen.has(key)) throw problem("A write cannot change the same path more than once.");
      seen.add(key);
      if ("content" in change && change.content.length > LOCAL_FILE_CHAR_LIMIT) throw problem(`File content exceeds the ${LOCAL_FILE_CHAR_LIMIT}-character limit.`);
      if ("content" in change && change.content.includes("\0")) throw problem("Only UTF-8 text files without NUL bytes can be written.");
      const { parts } = resolveChild(state.root, change.path);
      await assertPathComponents(state.root, parts, false);
      const current = await inspectTarget(state.root, change.path);
      if ("delete" in change && !baseline.has(change.path)) throw problem("Cannot delete a missing or inaccessible file.");
      if (current.exists !== baseline.has(change.path)) throw problem("Workspace changed since the last snapshot; refresh before continuing.");
    }
    const planned = new Map(baseline);
    for (const change of changes) {
      if ("delete" in change) planned.delete(change.path);
      else planned.set(change.path, { content: change.content, hash: createHash("sha256").update(change.content, "utf8").digest("hex"), mode: planned.get(change.path)?.mode ?? "100644" });
    }
    if (planned.size > LOCAL_FILE_LIMIT) throw problem(`Workspace exceeds the ${LOCAL_FILE_LIMIT}-file local execution limit.`);
    const receipt = changes.map(change => ({ path: change.path, before: baseline.get(change.path)?.content ?? null, after: planned.get(change.path)?.content ?? null }));
    if (!Number.isFinite(receiptBudget) || receiptBudget < 0 || Buffer.byteLength(JSON.stringify(receipt)) > Math.min(receiptBudget, 1_000_000)) {
      throw problem("Change receipt exceeds the transfer budget; split the task before writing.");
    }
    const paths = [...seen];
    for (const filename of paths) {
      const lower = filename.toLowerCase();
      for (const other of paths) {
        if (other === filename) continue;
        if (other.toLowerCase().startsWith(`${lower}/`)) throw problem("A batch cannot use a file as another file's parent directory.");
      }
    }

    const staged = new Map<string, string>();
    try {
      for (const change of changes) {
        if (!("content" in change)) continue;
        const parts = validRelativePath(change.path);
        await ensureParents(state.root, parts);
        const target = path.join(state.root, ...parts), temporary = path.join(path.dirname(target), `.scenarioforge-local-tmp-${randomUUID().replaceAll("-", "")}`);
        const previousMode = baseline.get(change.path)?.mode === "100755" ? 0o755 : 0o644;
        const handle = await open(temporary, "wx", previousMode);
        try { await handle.writeFile(change.content, "utf8"); } finally { await handle.close(); }
        staged.set(change.path, temporary);
      }

      const expected = new Map(baseline);
      for (const change of changes) {
        const current = await scan(state.root);
        assertHead(current, headOf(expected));
        const { parts, target } = resolveChild(state.root, change.path);
        await assertPathComponents(state.root, parts, false);
        const targetState = await inspectTarget(state.root, change.path);
        const prior = expected.get(change.path);
        if (targetState.exists !== !!prior) throw problem("Workspace changed during the write; refresh before continuing.");
        if (prior) {
          const actual = await readSafeFile(state.root, change.path);
          if (!actual || createHash("sha256").update(actual.content, "utf8").digest("hex") !== prior.hash) throw problem("Workspace changed during the write; refresh before continuing.");
        }
        if ("delete" in change) {
          await unlink(target);
          expected.delete(change.path);
        } else {
          const temporary = staged.get(change.path);
          if (!temporary) throw problem("Staged file is missing.");
          await rename(temporary, target);
          staged.delete(change.path);
          expected.set(change.path, { content: change.content, hash: createHash("sha256").update(change.content, "utf8").digest("hex"), mode: prior?.mode ?? "100644" });
        }
      }
    } finally {
      await Promise.all([...staged.values()].map(temporary => rm(temporary, { force: true }).catch(() => {})));
    }
    const updated = await scan(state.root), head = assertHead(updated, headOf(planned));
    const entries = changes.map(change => ({ path: change.path, before: baseline.get(change.path)?.content ?? null, after: updated.get(change.path)?.content ?? null }));
    return { head, changedPaths: changes.map(change => change.path), entries };
  });
}

export async function diffWorkspace(executionId: string, expectedHead?: string): Promise<LocalWorkspaceDiff> {
  return withLock(executionId, async () => {
    const state = await requireState(executionId), current = await scan(state.root), head = assertHead(current, expectedHead);
    const changedPaths = [...new Set([...state.baseline.keys(), ...current.keys()])].filter(filename => state.baseline.get(filename)?.hash !== current.get(filename)?.hash || state.baseline.get(filename)?.mode !== current.get(filename)?.mode).sort();
    const files = changedPaths.map(filename => {
      const before = state.baseline.get(filename)?.content ?? null, after = current.get(filename)?.content ?? null;
      return { path: filename, status: before === null ? "added" as const : after === null ? "deleted" as const : "modified" as const, before, after };
    });
    return { baseHead: state.baselineHead, head, changedPaths, files };
  });
}

export async function closeWorkspace(executionId: string) {
  return withLock(executionId, async () => { executions.delete(executionId); });
}

/** The callback is a local process operation; the absolute root never leaves this process. */
export async function withWorkspaceCommand<T>(executionId: string, expectedHead: string, receiptBudget: number, action: (root: string, assertUnchanged: () => Promise<void>) => Promise<T>) {
  return withLock(executionId, async () => {
    if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw problem("Invalid workspace tree head.");
    if (!Number.isFinite(receiptBudget) || receiptBudget < 0) throw problem("Invalid command change receipt budget.");
    const state = await requireState(executionId), before = await scan(state.root);
    assertHead(before, expectedHead);
    const value = await action(state.root, async () => { assertHead(await scan(state.root), expectedHead); });
    const after = await scan(state.root), head = headOf(after);
    const paths = [...new Set([...before.keys(), ...after.keys()])].filter(filename =>
      before.get(filename)?.hash !== after.get(filename)?.hash || before.get(filename)?.mode !== after.get(filename)?.mode).sort();
    const entries = paths.map(filename => ({ path: filename, before: before.get(filename)?.content ?? null, after: after.get(filename)?.content ?? null }));
    if (Buffer.byteLength(JSON.stringify(entries)) > Math.min(receiptBudget, 1_000_000)) {
      throw problem("Command changes exceed the receipt budget. Files remain on this computer; inspect the selected directory before resuming.");
    }
    return { value, beforeHead: expectedHead, head, entries };
  });
}
