import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeWorkspace, diffWorkspace, inspectWorkspace, listWorkspace, readWorkspace, snapshotWorkspace, writeWorkspace } from "../lib/local-runner/filesystem";

let nextId = 0;
async function fixture(run: (root: string, executionId: string, parent: string) => Promise<void>) {
  const parent = await mkdtemp(path.join(tmpdir(), "sf-local-runner-test-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  const executionId = `filesystem-test-${++nextId}`;
  try { await run(root, executionId, parent); }
  finally { await closeWorkspace(executionId); await rm(parent, { recursive: true, force: true }); }
}

test("rejects oversized receipts before writing and inspects current manual changes", async () => fixture(async (root, executionId) => {
  await writeFile(path.join(root, "notes.md"), "original");
  const view = await snapshotWorkspace(root, executionId);
  await assert.rejects(writeWorkspace(executionId, view.head, [{ path: "notes.md", content: "changed" }], 1), /transfer budget/);
  assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "original");
  await writeFile(path.join(root, "notes.md"), "manual edit");
  const inspection = await inspectWorkspace(executionId, ["notes.md", "missing.md"]);
  assert.notEqual(inspection.head, view.head);
  assert.deepEqual(inspection.entries, [{ path: "notes.md", content: "manual edit" }, { path: "missing.md", content: null }]);
}));

test("confines reads and writes to the selected root", async () => fixture(async (root, executionId, parent) => {
  await writeFile(path.join(root, "readme.md"), "inside");
  const outside = path.join(parent, "secret.txt");
  await writeFile(outside, "outside-secret");
  const start = await snapshotWorkspace(root, executionId);
  assert.match(start.head, /^[a-f0-9]{40}$/);

  await assert.rejects(readWorkspace(executionId, "../secret.txt"), /Invalid workspace-relative path/);
  await assert.rejects(readWorkspace(executionId, outside), /Invalid workspace-relative path/);
  await assert.rejects(writeWorkspace(executionId, start.head, [{ path: "../secret.txt", content: "overwrite" }]), /Invalid workspace-relative path/);
  await assert.rejects(writeWorkspace(executionId, start.head, [{ path: "C:/secret.txt", content: "overwrite" }]), /Invalid workspace-relative path/);
  assert.equal(await readFile(outside, "utf8"), "outside-secret");
}));

test("omits repository internals, dependencies, env files and private keys", async () => fixture(async (root, executionId) => {
  const files: Record<string, string> = {
    "src/main.ts": "export const ok = true;",
    ".env": "SECRET=one",
    ".env.local": "SECRET=two",
    ".env.example": "EXAMPLE=allowed",
    ".git/config": "[core]",
    "node_modules/pkg/index.js": "module",
    ".ssh/id_rsa": "private",
    "nested/server.pem": "private",
    "nested/token.key": "private",
  };
  for (const [filename, content] of Object.entries(files)) {
    const target = path.join(root, ...filename.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const view = await snapshotWorkspace(root, executionId);
  assert.deepEqual(view.files.map(file => file.path), [".env.example", "src/main.ts"]);
  for (const filename of [".env", ".env.local", ".git/config", "node_modules/pkg/index.js", ".ssh/id_rsa", "nested/server.pem", "nested/token.key"]) {
    await assert.rejects(readWorkspace(executionId, filename));
  }
}));

test("does not follow symlinked files or directories", async t => fixture(async (root, executionId, parent) => {
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside-secret");
  let fileLinkCreated = false;
  try { await symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file.txt")); fileLinkCreated = true; }
  catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  try {
    await symlink(outside, path.join(root, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("symlink creation is unavailable on this host"); return; }
    throw error;
  }
  const view = await snapshotWorkspace(root, executionId);
  assert.deepEqual(view.files, []);
  if (fileLinkCreated) await assert.rejects(readWorkspace(executionId, "linked-file.txt"), /Symbolic links/);
  await assert.rejects(readWorkspace(executionId, "linked-directory/secret.txt"), /Symbolic links/);
  await assert.rejects(writeWorkspace(executionId, view.head, [{ path: "linked-directory/secret.txt", content: "overwrite" }]), /Symbolic links/);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside-secret");
}));

test("rejects stale tree heads and preserves existing local changes", async () => fixture(async (root, executionId) => {
  await writeFile(path.join(root, "file.txt"), "baseline");
  const start = await snapshotWorkspace(root, executionId);
  await writeFile(path.join(root, "file.txt"), "edited elsewhere");
  await assert.rejects(listWorkspace(executionId, "", start.head), /Workspace changed/);
  await assert.rejects(writeWorkspace(executionId, start.head, [{ path: "file.txt", content: "agent overwrite" }]), /Workspace changed/);
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "edited elsewhere");
}));

test("atomically writes and deletes files, then reports a baseline diff", async () => fixture(async (root, executionId) => {
  await writeFile(path.join(root, "change.txt"), "before\n");
  await writeFile(path.join(root, "remove.txt"), "to remove\n");
  const start = await snapshotWorkspace(root, executionId);
  const result = await writeWorkspace(executionId, start.head, [
    { path: "change.txt", content: "after\n" },
    { path: "nested/new.txt", content: "created\n" },
    { path: "remove.txt", delete: true },
  ]);

  assert.equal(await readFile(path.join(root, "change.txt"), "utf8"), "after\n");
  assert.equal(await readFile(path.join(root, "nested/new.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(path.join(root, "remove.txt"), "utf8"), /ENOENT/);
  assert.deepEqual((await listWorkspace(executionId, "", result.head)).files.map(file => file.path), ["change.txt", "nested/new.txt"]);
  const diff = await diffWorkspace(executionId, result.head);
  assert.deepEqual(result.entries, [
    { path: "change.txt", before: "before\n", after: "after\n" },
    { path: "nested/new.txt", before: null, after: "created\n" },
    { path: "remove.txt", before: "to remove\n", after: null },
  ]);
  assert.equal(diff.baseHead, start.head);
  assert.equal(diff.head, result.head);
  assert.deepEqual(diff.files, [
    { path: "change.txt", status: "modified", before: "before\n", after: "after\n" },
    { path: "nested/new.txt", status: "added", before: null, after: "created\n" },
    { path: "remove.txt", status: "deleted", before: "to remove\n", after: null },
  ]);
}));

test("enforces file count and content size limits", async () => fixture(async (root, executionId) => {
  const start = await snapshotWorkspace(root, executionId);
  await assert.rejects(writeWorkspace(executionId, start.head, [{ path: "large.txt", content: "x".repeat(40_001) }]), /40000-character limit/);
  for (let index = 0; index <= 300; index++) await writeFile(path.join(root, `file-${index}.txt`), "x");
  await assert.rejects(listWorkspace(executionId), /300-file local execution limit/);
}));

test("does not expose an absolute workspace path in filesystem errors", async () => fixture(async (root, executionId) => {
  const missing = path.join(root, "missing-root");
  await assert.rejects(snapshotWorkspace(missing, executionId), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Local filesystem operation failed \(ENOENT\)/);
    assert.ok(!error.message.includes(root));
    return true;
  });
}));
