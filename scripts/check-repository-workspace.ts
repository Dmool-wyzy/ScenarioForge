import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importGitHubRepository, initializeDemoRepository, prepareRepositoryImport, pullRepositoryMain, pushRepositoryMain, repositoryPath, repositorySummary } from "../lib/repository";
import { assertRepositoryBranchWrite, commitRepositoryFiles, compareRepositoryBranch, createRepositoryBranch, deleteRepositoryBranch, mergeRepositoryBranch, repositoryCommitDetail, repositoryFile, repositoryFilePath, repositoryHistory, repositoryWorkspace } from "../lib/repository-workspace";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trimEnd();
const alice = { id: "alice", username: "成员甲", owner: false }, bob = { id: "bob", username: "成员乙", owner: false }, owner = { id: "owner", username: "组长", owner: true };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-workspace-test-")), previous = process.env.SCENARIOFORGE_GIT_ROOT;
  process.env.SCENARIOFORGE_GIT_ROOT = path.join(root, "repos");
  try { await initializeDemoRepository("project"); await run(root); }
  finally { if (previous === undefined) delete process.env.SCENARIOFORGE_GIT_ROOT; else process.env.SCENARIOFORGE_GIT_ROOT = previous; await rm(root, { recursive: true, force: true }); }
}

test("files, binary uploads, history, review and branch deletion use real atomic Git commits", async () => fixture(async () => {
  const initial = (await repositorySummary("project")).head;
  const { branch } = await createRepositoryBranch("project", alice, "feature/docs", "main", initial);
  const content = "\ufeff# 中文\r\n保留末尾空行  \r\n\r\n", binary = Buffer.from([0, 255, 10, 128, 13]);
  const { commit } = await commitRepositoryFiles("project", alice, branch, initial, "添加文档和图片", [
    { path: "docs/中文 空格.md", content, encoding: "utf8" }, { path: "assets/image.bin", content: binary.toString("base64"), encoding: "base64" }, { path: "empty.txt", content: "" },
  ]);
  assert.equal((await repositoryFile("project", branch, "docs/中文 空格.md")).text, content);
  assert.equal((await repositoryFile("project", branch, "assets/image.bin")).base64, binary.toString("base64"));
  assert.equal((await repositoryFile("project", branch, "assets/image.bin")).text, null);
  assert.equal((await repositoryFile("project", branch, "empty.txt")).text, "");
  assert.equal((await repositoryWorkspace("project", branch, alice)).files.length, 4);
  assert.equal((await repositorySummary("project")).head, initial, "editing a branch never edits main");
  assert.equal(await git(repositoryPath("project"), ["status", "--porcelain"]), "");
  assert.equal((await repositoryHistory("project", branch)).commits[0].subject, "添加文档和图片");
  assert.equal((await repositoryHistory("project", branch)).commits[0].author, alice.username);
  assert.match((await repositoryCommitDetail("project", branch, commit)).diff, /Submitted-by: 成员甲/);
  await assert.rejects(repositoryCommitDetail("project", "main", commit), { status: 404 });
  await assert.rejects(commitRepositoryFiles("project", alice, branch, initial, "stale", [{ path: "overwrite.txt", content: "x" }]), { status: 409 });
  await assert.rejects(deleteRepositoryBranch("project", branch, commit, alice), /未合并/);
  const moved = await commitRepositoryFiles("project", alice, branch, commit, "重命名并移除空文件", [{ path: "docs/中文 空格.md", delete: true }, { path: "docs/改名.md", content }, { path: "empty.txt", delete: true }]);
  await assert.rejects(repositoryFile("project", branch, "empty.txt"), { status: 404 });
  const review = await compareRepositoryBranch("project", branch);
  assert.equal(review.commit, moved.commit); assert.equal(review.merged, false); assert.equal(review.truncated, false);
  await mergeRepositoryBranch("project", branch, review.head, review.commit);
  assert.equal((await compareRepositoryBranch("project", branch)).merged, true);
  assert.equal((await repositoryFile("project", "main", "docs/改名.md")).text, content);
  await deleteRepositoryBranch("project", branch, moved.commit, owner);
  await assert.rejects(repositoryWorkspace("project", branch, alice), { status: 404 });
  assert.match((await repositoryHistory("project", "main")).commits[0].subject, /Merge reviewed/);
}));

test("member isolation, path validation, symlink safety and stale approvals", async () => fixture(async () => {
  const head = (await repositorySummary("project")).head;
  const { branch } = await createRepositoryBranch("project", alice, "test", "main", head);
  for (const invalid of ["../outside", "/etc/passwd", "C:/secrets", ".git/config", "src/.GiT/hooks/x", "a\\b", "a\0b", "dir/../x", "con.txt", "x.", "a//x"]) assert.throws(() => repositoryFilePath(invalid), { status: 400 });
  assert.throws(() => assertRepositoryBranchWrite(branch, bob), { status: 403 });
  for (const name of ["main", "task/task-a"]) assert.throws(() => assertRepositoryBranchWrite(name, owner), { status: 403 });
  await assert.rejects(commitRepositoryFiles("project", bob, branch, head, "unauthorized", [{ path: "x", content: "x" }]), { status: 403 });
  await assert.rejects(deleteRepositoryBranch("project", branch, head, bob), { status: 403 });
  await assert.rejects(createRepositoryBranch("project", alice, "test", "main", head), { status: 409 });
  await assert.rejects(commitRepositoryFiles("project", alice, branch, head, "duplicate", [{ path: "a", content: "1" }, { path: "A", content: "2" }]), { status: 400 });
  await assert.rejects(commitRepositoryFiles("project", alice, branch, head, "bad encoding", [{ path: "a", content: "@$", encoding: "base64" }]), { status: 400 });
  await assert.rejects(commitRepositoryFiles("project", alice, branch, head, "large", [{ path: "a", content: "x".repeat(1024 * 1024 + 1) }]), { status: 413 });
  const cwd = repositoryPath("project"), readme = await readFile(path.join(cwd, "README.md"), "utf8");
  await assert.rejects(commitRepositoryFiles("project", alice, branch, head, "no change", [{ path: "README.md", content: readme }]), /没有变化/);
  await assert.rejects(commitRepositoryFiles("project", alice, branch, head, "parent collision", [{ path: "README.md/a", content: "x" }]), /冲突/);
  const next = await commitRepositoryFiles("project", alice, branch, head, "new", [{ path: "hello.txt", content: "hello" }]);
  await assert.rejects(mergeRepositoryBranch("project", branch, head, head), { status: 409 });
  await git(cwd, ["update-index", "--add", "--cacheinfo", "120000", await git(cwd, ["rev-parse", `${head}:README.md`]), "link"]);
  await git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture symlink"]);
  const current = (await repositorySummary("project")).head;
  const linked = await createRepositoryBranch("project", alice, "link", "main", current);
  const read = await repositoryFile("project", linked.branch, "link"); assert.equal(read.base64, null);
  await assert.rejects(commitRepositoryFiles("project", alice, linked.branch, current, "follow link", [{ path: "link/secret", content: "x" }]), /冲突/);
  await assert.rejects(commitRepositoryFiles("project", alice, linked.branch, current, "edit link", [{ path: "link", content: "x" }]), /符号链接/);
  assert.equal((await repositoryWorkspace("project", branch, alice)).head, next.commit);
}));

test("conflicting merges abort cleanly and preserve both branches", async () => fixture(async () => {
  const initial = (await repositorySummary("project")).head;
  const a = await createRepositoryBranch("project", alice, "conflict", "main", initial), b = await createRepositoryBranch("project", bob, "conflict", "main", initial);
  const first = await commitRepositoryFiles("project", alice, a.branch, initial, "A", [{ path: "README.md", content: "Alice\n" }]);
  const second = await commitRepositoryFiles("project", bob, b.branch, initial, "B", [{ path: "README.md", content: "Bob\n" }]);
  await mergeRepositoryBranch("project", a.branch, initial, first.commit);
  const before = (await repositorySummary("project")).head;
  await assert.rejects(mergeRepositoryBranch("project", b.branch, before, second.commit), /冲突/);
  assert.equal((await repositorySummary("project")).head, before);
  assert.equal((await repositoryWorkspace("project", b.branch, bob)).head, second.commit);
  assert.equal(await readFile(path.join(repositoryPath("project"), "README.md"), "utf8"), "Alice\n");
  assert.equal(await git(repositoryPath("project"), ["status", "--porcelain"]), "");
  await assert.rejects(git(repositoryPath("project"), ["rev-parse", "--verify", "MERGE_HEAD"]));
}));

test("remote pull fast-forwards selected branch, preserves local commits and rejects divergence/races", async () => fixture(async root => {
  const upstream = path.join(root, "upstream.git"), author = path.join(root, "author");
  await mkdir(author); await git(root, ["init", "--bare", "--initial-branch=master", upstream]); await git(author, ["init", "--initial-branch=master"]);
  await git(author, ["config", "user.name", "Fixture"]); await git(author, ["config", "user.email", "fixture@example.invalid"]);
  const publish = async (name: string) => { await writeFile(path.join(author, name), name); await git(author, ["add", "."]); await git(author, ["commit", "-m", name]); await git(author, ["push", upstream, "master"]); return git(author, ["rev-parse", "HEAD"]); };
  const original = await publish("original.txt");
  const transport = async (cwd: string, args: string[]) => git(cwd, args.map(arg => arg === "ssh://git@ssh.github.com:443/fixture/repo.git" ? upstream : arg));
  await prepareRepositoryImport("project", "https://github.com/fixture/repo.git"); await importGitHubRepository("project", transport);
  const remote = await publish("remote.txt");
  await assert.rejects(pullRepositoryMain("project", original, original, transport), /远程分支已改变/);
  await pullRepositoryMain("project", original, remote, transport);
  assert.equal((await repositorySummary("project")).head, remote);
  const localBranch = await createRepositoryBranch("project", alice, "local", "main", remote);
  const localCommit = await commitRepositoryFiles("project", alice, localBranch.branch, remote, "local", [{ path: "local.txt", content: "local" }]);
  await mergeRepositoryBranch("project", localBranch.branch, remote, localCommit.commit);
  const ahead = (await repositorySummary("project")).head;
  await pullRepositoryMain("project", ahead, remote, transport);
  assert.equal((await repositorySummary("project")).head, ahead, "pull never resets a locally ahead branch");
  await pushRepositoryMain("project", ahead, remote, transport);
  assert.equal(await git(upstream, ["rev-parse", "master"]), ahead);
  await git(author, ["pull", "--ff-only", upstream, "master"]);
  const another = await createRepositoryBranch("project", alice, "diverge", "main", ahead);
  const anotherCommit = await commitRepositoryFiles("project", alice, another.branch, ahead, "another local", [{ path: "local2.txt", content: "local2" }]);
  await mergeRepositoryBranch("project", another.branch, ahead, anotherCommit.commit);
  const diverged = (await repositorySummary("project")).head, remote2 = await publish("remote2.txt");
  await assert.rejects(pullRepositoryMain("project", diverged, remote2, transport), /无法快进/);
  assert.equal((await repositorySummary("project")).head, diverged);
}));
