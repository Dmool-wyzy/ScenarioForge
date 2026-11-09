import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectEmptyGitHubRepository, githubRepositoryUrl, initializeDemoRepository, mergeTaskDelivery, repositoryOperation, repositoryPath, repositorySummary, reviewTaskDelivery, storeTaskDelivery, verifyEmptyGitHubRepository } from "../lib/repository";
import { checkRepositoryRemote, createRepositoryDeployKey, githubSshCommand, pushRepositoryMain, repositoryRemoteStatus } from "../lib/repository";

test("repository deploy keys are isolated and pushes verify both heads without forcing remote history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-remote-test-"));
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  const exec = promisify(execFile);
  const bare = path.join(root, "remote.git");
  let networkCalls = 0;
  const transport = async (cwd: string, args: string[], ssh?: string) => {
    networkCalls++;
    assert.match(ssh ?? "", /StrictHostKeyChecking=yes/);
    assert.match(ssh ?? "", /IdentityAgent=none/);
    assert.equal(args.includes("--force"), false);
    const url = "ssh://git@ssh.github.com:443/owner/repository.git";
    assert.equal(args.includes(url), true);
    const { stdout } = await exec("git", args.map(arg => arg === url ? bare : arg), { cwd, timeout: 10000 });
    return stdout.trimEnd();
  };
  try {
    await exec("git", ["init", "--bare", bare]);
    await connectEmptyGitHubRepository("project-a", "https://github.com/owner/repository", async () => new Response(null, { status: 409 }));
    await assert.rejects(checkRepositoryRemote("project-a", transport), /部署密钥/);
    const key = await createRepositoryDeployKey("project-a");
    assert.match(key.publicKey ?? "", /^ssh-ed25519 /);
    assert.equal((await createRepositoryDeployKey("project-a")).publicKey, key.publicKey);
    assert.equal(Object.hasOwn(await repositoryRemoteStatus("project-a"), "publicKey"), false);
    assert.equal((await repositoryRemoteStatus("project-b")).configured, false);
    assert.match(githubSshCommand("project-a"), /HostKeyAlgorithms=ssh-ed25519/);
    assert.equal((await checkRepositoryRemote("project-a", transport)).head, null);
    const initial = await repositorySummary("project-a");
    const pending = { id: "private-task", objective: "未合并任务", assigneeName: "member", result: "不得推送未合并内容" };
    await storeTaskDelivery("project-a", pending);
    const calls = networkCalls;
    await assert.rejects(pushRepositoryMain("project-a", "0".repeat(40), null, transport), /本地 main 已改变/);
    assert.equal(networkCalls, calls);
    assert.equal((await pushRepositoryMain("project-a", initial.head, null, transport)).head, initial.head);
    assert.equal((await exec("git", ["ls-tree", "-r", "--name-only", "refs/heads/main"], { cwd: bare })).stdout.trim(), "README.md");
    assert.equal((await exec("git", ["for-each-ref", "refs/heads/task/"], { cwd: bare })).stdout, "");
    await assert.rejects(pushRepositoryMain("project-a", initial.head, null, transport), /远程 main 已改变/);
    const review = await reviewTaskDelivery("project-a", pending.id);
    const merged = await mergeTaskDelivery("project-a", pending.id, review.head, review.commit);
    await assert.rejects(pushRepositoryMain("project-a", merged, initial.head, async (_cwd, args) => {
      if (args[0] === "ls-remote") return initial.head + "\trefs/heads/main";
      throw Object.assign(new Error("sensitive transport details"), { stderr: "rejected non-fast-forward" });
    }), /不会强制覆盖/);
    assert.equal((await pushRepositoryMain("project-a", merged, initial.head, transport)).head, merged);
    assert.match((await exec("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: bare })).stdout, /deliveries\/private-task.md/);
    await assert.rejects(checkRepositoryRemote("project-a", async () => { throw Object.assign(new Error("sensitive details"), { stderr: "Permission denied (publickey)" }); }), /GitHub 尚未授权/);
    await assert.rejects(checkRepositoryRemote("project-a", async () => { throw Object.assign(new Error("sensitive details"), { stderr: "Connection timed out; Could not read from remote repository" }); }), /请检查网络/);
    await writeFile(path.join(repositoryPath("project-a"), "uncommitted.txt"), "keep");
    await assert.rejects(pushRepositoryMain("project-a", merged, merged, transport), /未提交修改/);
  } finally { delete process.env.SCENARIOFORGE_GIT_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("GitHub association only accepts an explicit public empty repository and sends no credentials", async () => {
  assert.deepEqual(githubRepositoryUrl("https://github.com/owner/repository.git"), { slug: "owner/repository", url: "https://github.com/owner/repository.git" });
  for (const value of ["http://github.com/owner/repository", "https://token@github.com/owner/repository", "https://github.com.evil/owner/repository", "https://github.com/owner/repository?token=secret", "https://github.com/owner/../repository", "file:///tmp/repository"]) assert.throws(() => githubRepositoryUrl(value), /GitHub HTTPS/);
  const empty: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/owner/repository/commits?per_page=1");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.redirect, "error");
    return new Response(null, { status: 409 });
  };
  assert.equal((await verifyEmptyGitHubRepository("https://github.com/owner/repository", empty)).slug, "owner/repository");
  await assert.rejects(verifyEmptyGitHubRepository("https://github.com/owner/repository", async () => new Response("[]")), /已有提交/);
  await assert.rejects(verifyEmptyGitHubRepository("https://github.com/owner/repository", async () => new Response(null, { status: 404 })), /私有仓库认证/);
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-github-test-"));
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  try {
    await connectEmptyGitHubRepository("project", "https://github.com/owner/repository.git", empty);
    const repo = await repositorySummary("project");
    assert.equal(repo.remoteUrl, "https://github.com/owner/repository.git");
    assert.deepEqual(repo.files, ["README.md"]);
    assert.deepEqual(repo.branches, []);
    await assert.rejects(connectEmptyGitHubRepository("project", "https://github.com/other/repository", async () => new Response(null, { status: 409 })), /不自动替换/);
  } finally { delete process.env.SCENARIOFORGE_GIT_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("Git delivery uses isolated branches, exact review commits and preserves main until explicit merge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenarioforge-git-test-"));
  process.env.SCENARIOFORGE_GIT_ROOT = root;
  try {
    assert.throws(() => repositoryPath("../outside"), /标识无效/);
    await initializeDemoRepository("project-a");
    await initializeDemoRepository("project-a");
    const initial = await repositorySummary("project-a");
    assert.deepEqual(initial.files, ["README.md"]);
    const first = { id: "task-a", objective: "审查方案", assigneeName: "member", result: "已确认的交付，包含 `code` 和 $(不执行)" };
    const commit = await storeTaskDelivery("project-a", first);
    assert.equal(await storeTaskDelivery("project-a", first), commit);
    await assert.rejects(storeTaskDelivery("project-a", { ...first, result: "被修改" }), /内容已变化/);
    assert.equal((await repositorySummary("project-a")).head, initial.head);
    const review = await reviewTaskDelivery("project-a", first.id);
    assert.match(review.diff, /已确认的交付/);
    assert.equal(review.commit, commit);
    const second = { ...first, id: "task-b", result: "独立交付 B" };
    await storeTaskDelivery("project-a", second);
    await assert.rejects(mergeTaskDelivery("project-a", first.id, initial.head, "0".repeat(40)), /重新查看/);
    const merged = await mergeTaskDelivery("project-a", first.id, review.head, review.commit);
    assert.notEqual(merged, initial.head);
    assert.equal((await reviewTaskDelivery("project-a", first.id)).merged, true);
    const secondReview = await reviewTaskDelivery("project-a", second.id);
    await assert.rejects(mergeTaskDelivery("project-a", second.id, initial.head, secondReview.commit), /重新查看/);
    await mergeTaskDelivery("project-a", second.id, secondReview.head, secondReview.commit);
    assert.deepEqual((await repositorySummary("project-a")).files.sort(), ["README.md", "deliveries/task-a.md", "deliveries/task-b.md"]);
    await initializeDemoRepository("project-b");
    assert.deepEqual((await repositorySummary("project-b")).branches, []);
    await writeFile(path.join(repositoryPath("project-b"), "uncommitted.txt"), "keep");
    const thirdCommit = await storeTaskDelivery("project-b", { ...first, id: "task-c" });
    await assert.rejects(mergeTaskDelivery("project-b", "task-c", (await repositorySummary("project-b")).head, thirdCommit), /未提交修改/);
    await repositoryOperation("project-a", async () => { await assert.rejects(repositoryOperation("project-a", async () => {}), /另一操作/); });
  } finally { delete process.env.SCENARIOFORGE_GIT_ROOT; await rm(root, { recursive: true, force: true }); }
});
