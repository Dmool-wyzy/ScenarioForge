import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRepositoryRemote, importGitHubRepository, initializeDemoRepository, mergeTaskDelivery, prepareRepositoryImport, pushRepositoryMain, repositoryBranch, repositoryPath, repositoryRemoteStatus, repositorySummary, reviewTaskDelivery, storeTaskDelivery } from "../lib/repository";

const exec = promisify(execFile);
test("authorized private/existing import preserves history and pushes to the selected default branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-import-test-"));
  const before = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = path.join(root, "projects");
  const upstream = path.join(root, "upstream.git"), author = path.join(root, "author");
  const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trimEnd();
  let allowed = false, writes = 0;
  const transport = async (cwd: string, args: string[], ssh?: string) => {
    assert.match(ssh ?? "", /StrictHostKeyChecking=yes/);
    assert.match(ssh ?? "", /credentials.*private-project/);
    assert.equal(args.includes("--force"), false);
    if (!allowed) throw Object.assign(new Error("private detail"), { stderr: "Permission denied (publickey)" });
    if (args[0] === "push") writes++;
    const url = "ssh://git@ssh.github.com:443/owner/private.git";
    assert.ok(args.includes(url));
    return git(cwd, args.map(arg => arg === url ? upstream : arg));
  };
  try {
    await mkdir(author);
    await git(root, ["init", "--bare", "--initial-branch=master", upstream]);
    await git(author, ["init", "--initial-branch=master"]);
    await git(author, ["config", "user.name", "Fixture"]); await git(author, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(author, "README.md"), "existing private content");
    await git(author, ["add", "."]); await git(author, ["commit", "-m", "Existing initial commit"]);
    await writeFile(path.join(author, "app.txt"), "preserve application files");
    await git(author, ["add", "."]); await git(author, ["commit", "-m", "Existing second commit"]);
    const originalHead = await git(author, ["rev-parse", "HEAD"]);
    await git(author, ["push", upstream, "master"]);
    await initializeDemoRepository("private-project");
    const initialHead = (await repositorySummary("private-project")).head;
    const setup = await prepareRepositoryImport("private-project", "https://github.com/owner/private.git");
    assert.match(setup.publicKey ?? "", /^ssh-ed25519/);
    assert.equal(setup.connection?.imported, false);
    assert.equal(Object.hasOwn(await repositoryRemoteStatus("private-project"), "publicKey"), false);
    await assert.rejects(importGitHubRepository("private-project", transport), /GitHub 尚未授权/);
    assert.equal((await readdir(process.env.SCENARIOFORGE_GIT_ROOT)).some(name => name.startsWith(".import-")), false);
    assert.equal((await repositorySummary("private-project")).head, initialHead);
    allowed = true;
    const imported = await importGitHubRepository("private-project", transport);
    assert.equal(imported.head, originalHead);
    assert.equal(imported.remoteBranch, "master");
    assert.deepEqual(imported.files.sort(), ["README.md", "app.txt"]);
    assert.equal(await git(repositoryPath("private-project"), ["rev-list", "--count", "main"]), "2");
    assert.equal((await repositoryRemoteStatus("private-project")).connection?.imported, true);
    assert.equal((await importGitHubRepository("private-project", transport)).head, originalHead, "retry does not replace imported content");
    assert.equal(writes, 0, "import never pushes upstream");
    assert.equal((await checkRepositoryRemote("private-project", transport)).head, originalHead);
    const task = { id: "task-a", objective: "交付", assigneeName: "成员", result: "追加文档" };
    await storeTaskDelivery("private-project", task);
    const review = await reviewTaskDelivery("private-project", task.id);
    const merged = await mergeTaskDelivery("private-project", task.id, review.head, review.commit);
    await pushRepositoryMain("private-project", merged, originalHead, transport);
    assert.equal(await git(upstream, ["rev-parse", "master"]), merged);
    assert.equal(await git(upstream, ["for-each-ref", "refs/heads/main"]), "", "does not accidentally create main on a master repository");
    assert.equal(await readFile(path.join(repositoryPath("private-project"), "app.txt"), "utf8"), "preserve application files");
    await assert.rejects(prepareRepositoryImport("private-project", "https://github.com/owner/other"), /已有提交、交付或仓库连接/);
  } finally { if (before === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT; else process.env.SCENARIOFORGE_GIT_ROOT = before; await rm(root, { recursive: true, force: true }); }
});

test("import handles empty repos, branch validation, failed fetch cleanup and existing workspace protection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-import-failure-test-"));
  const before = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  try {
    for (const name of ["../main", "-main", "main.lock", "a/.hidden", "a//b", "main:other", "HEAD", "a..b", "main/", "main "]) assert.throws(() => repositoryBranch(name), /分支名无效/);
    assert.equal(repositoryBranch("release/v1.0"), "release/v1.0");
    await prepareRepositoryImport("empty", "https://github.com/owner/empty", "release/new");
    const empty = await importGitHubRepository("empty", async (_cwd, args) => { assert.equal(args[0], "ls-remote"); return ""; });
    assert.equal(empty.remoteBranch, "release/new"); assert.deepEqual(empty.files, ["README.md"]);
    await prepareRepositoryImport("failed", "https://github.com/owner/repo", "develop");
    const originalKey = (await repositoryRemoteStatus("failed", true)).publicKey;
    await assert.rejects(prepareRepositoryImport("failed", "https://github.com/other/repo"), /其他仓库/);
    await assert.rejects(importGitHubRepository("failed", async () => "a".repeat(40) + "\trefs/heads/main"), /没有该分支/);
    await assert.rejects(importGitHubRepository("failed", async (_cwd, args) => {
      if (args[0] === "ls-remote") return "a".repeat(40) + "\trefs/heads/develop";
      throw new Error("transport interrupted");
    }), /请检查网络/);
    assert.equal((await readdir(root)).some(name => name.startsWith(".import-") || name === "failed"), false);
    assert.equal((await repositoryRemoteStatus("failed", true)).publicKey, originalKey);
    await prepareRepositoryImport("failed", "https://github.com/owner/repo", "main");
    assert.equal((await repositoryRemoteStatus("failed")).connection?.branch, "main");
    await assert.rejects(initializeDemoRepository("failed"), /先完成授权和导入/);
    await initializeDemoRepository("existing");
    const beforeHead = (await repositorySummary("existing")).head;
    await prepareRepositoryImport("existing", "https://github.com/owner/repo");
    assert.equal((await repositorySummary("existing")).head, beforeHead);
    await assert.rejects(importGitHubRepository("existing", async () => { throw new Error("offline"); }), /请检查网络/);
    assert.equal((await repositorySummary("existing")).head, beforeHead);
    await importGitHubRepository("existing", async () => "");
    const backups = await readdir(path.join(root, "backups", "existing"));
    assert.equal(backups.length, 1);
    const backup = path.join(root, "backups", "existing", backups[0], "repository");
    assert.equal((await exec("git", ["rev-parse", "main"], { cwd: backup })).stdout.trim(), beforeHead);
    await initializeDemoRepository("changed");
    await prepareRepositoryImport("changed", "https://github.com/owner/repo");
    await writeFile(path.join(repositoryPath("changed"), "my-work.txt"), "preserve me");
    await assert.rejects(importGitHubRepository("changed", async () => ""), /已有提交、交付或仓库连接/);
    assert.equal(await readFile(path.join(repositoryPath("changed"), "my-work.txt"), "utf8"), "preserve me");
  } finally { if (before === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT; else process.env.SCENARIOFORGE_GIT_ROOT = before; await rm(root, { recursive: true, force: true }); }
});

test("imported delivery paths cannot overwrite existing files or follow a repository symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-import-path-test-"));
  const before = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = path.join(root, "projects");
  const author = path.join(root, "author");
  const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trimEnd();
  const transport = async (cwd: string, args: string[]) => git(cwd, args.map(arg => arg === "ssh://git@ssh.github.com:443/owner/repo.git" ? author : arg));
  try {
    await mkdir(path.join(author, "deliveries"), { recursive: true });
    await git(author, ["init", "--initial-branch=main"]);
    await git(author, ["config", "user.name", "Fixture"]); await git(author, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(author, "deliveries", "task-a.md"), "original file");
    await git(author, ["add", "."]); await git(author, ["commit", "-m", "Existing delivery"]);
    await prepareRepositoryImport("collision", "https://github.com/owner/repo");
    await importGitHubRepository("collision", transport);
    const task = { id: "task-a", objective: "交付", assigneeName: "成员", result: "cannot overwrite" };
    await assert.rejects(storeTaskDelivery("collision", task), /同名交付文件/);
    assert.equal(await readFile(path.join(repositoryPath("collision"), "deliveries", "task-a.md"), "utf8"), "original file");
    await git(author, ["rm", "deliveries/task-a.md"]);
    await writeFile(path.join(author, "link-target.txt"), "../outside");
    const blob = await git(author, ["hash-object", "-w", "link-target.txt"]);
    await git(author, ["update-index", "--add", "--cacheinfo", `120000,${blob},deliveries`]);
    await git(author, ["commit", "-m", "Symlink delivery path"]);
    await prepareRepositoryImport("symlink", "https://github.com/owner/repo");
    await importGitHubRepository("symlink", transport);
    await assert.rejects(storeTaskDelivery("symlink", task), /不是普通目录/);
    assert.deepEqual((await repositorySummary("symlink")).branches, []);
  } finally { if (before === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT; else process.env.SCENARIOFORGE_GIT_ROOT = before; await rm(root, { recursive: true, force: true }); }
});
