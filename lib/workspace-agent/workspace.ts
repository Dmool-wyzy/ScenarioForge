import "server-only";
import { ApiError } from "../errors";
import { repositoryGit, repositoryOperation, repositoryPath, repositorySummary } from "../repository";
import { commitRepositoryFiles, repositoryFile, repositoryFilePath, repositoryWorkspace, type RepositoryActor, type RepositoryChange } from "../repository-workspace";
import { skillDocument } from "./skills";
import type { SkillFile } from "./types";

export function agentFilePath(value: string, allowSkills = false) {
  const filename = repositoryFilePath(value);
  const parts = filename.toLowerCase().split("/");
  if ((parts[0] === ".scenarioforge" && (!allowSkills || parts[1] !== "skills" || parts.length !== 3 || !/^[a-f0-9]{16}-.+\.md$/.test(parts[2]))) || parts.some(part => ["node_modules", ".ssh", ".aws", ".venv"].includes(part)) ||
      parts.some(part => (/^\.env(?:\.|$)/.test(part) && !/\.(example|sample|template)$/.test(part)) || /^(id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i.test(part)))
    throw new ApiError(403, "该路径不属于 Agent 可操作的项目文件。");
  return filename;
}
export class AgentWorkspace {
  constructor(readonly projectId: string, readonly branch: string, readonly actor: RepositoryActor, private assertActive: () => Promise<void> = async () => {}) {}
  async list(query = "") {
    await this.assertActive();
    const view = await repositoryOperation(this.projectId, () => repositoryWorkspace(this.projectId, this.branch, this.actor));
    const files = view.files.filter(file => { try { agentFilePath(file.path, true); return file.path.includes(query); } catch { return false; } });
    return { head: view.head, files: files.slice(0, 300).map(({ path, mode, size }) => ({ path, mode, size })), total: files.length };
  }
  async read(filename: string) {
    await this.assertActive();
    const file = await repositoryOperation(this.projectId, () => repositoryFile(this.projectId, this.branch, agentFilePath(filename, true)));
    if (file.text === null) throw new ApiError(400, file.reason ?? "只能读取普通 UTF-8 文本。");
    if (file.text.length > 40000) throw new ApiError(413, "文件超过单次读取的 40000 字符上限，请缩小文件。");
    return { path: filename, head: file.head, content: file.text };
  }
  async write(head: string, changes: RepositoryChange[], reason: string) {
    await this.assertActive();
    for (const change of changes) agentFilePath(change.path);
    return repositoryOperation(this.projectId, () => commitRepositoryFiles(this.projectId, this.actor, this.branch, head, reason, changes));
  }
  async diff(base: string) {
    await this.assertActive();
    return repositoryOperation(this.projectId, async () => {
      const cwd = repositoryPath(this.projectId);
      const head = await repositoryGit(cwd, ["rev-parse", `refs/heads/${this.branch}`]);
      const changedPaths = (await repositoryGit(cwd, ["diff", "--name-only", "-z", base, head, "--"])).split("\0").filter(Boolean)
        .filter(filename => { try { agentFilePath(filename, true); return true; } catch { return false; } });
      return { head, changedPaths, diff: changedPaths.length ? await repositoryGit(cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", base, head, "--", ...changedPaths]) : "" };
    });
  }
}
export async function prepareAgentWorkspace(projectId: string, runId: string, actor: RepositoryActor, skills: SkillFile[], baseCommit?: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new ApiError(400, "执行编号无效。");
  return repositoryOperation(projectId, async () => {
    const summary = await repositorySummary(projectId);
    const base = baseCommit ?? summary.head;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ApiError(400, "任务起始提交无效。");
    const name = `agent-${runId}`, expectedBranch = `work/${actor.id}/${name}`;
    const existing = await repositoryGit(repositoryPath(projectId), ["rev-parse", "--verify", `refs/heads/${expectedBranch}`]).catch(() => null);
    if (existing) await repositoryGit(repositoryPath(projectId), ["merge-base", "--is-ancestor", base, existing]);
    const branch = expectedBranch;
    if (!existing) await repositoryGit(repositoryPath(projectId), ["update-ref", `refs/heads/${branch}`, base, "0".repeat(40)]);
    let head = existing ?? base;
    // Selected Markdown becomes immutable, inspectable skill files in this task branch.
    if (skills.length) {
      const changes: RepositoryChange[] = [];
      for (const skill of [...new Map(skills.map(skill => [skill.path, skill])).values()]) {
        const current = await repositoryGit(repositoryPath(projectId), ["show", `${head}:${skill.path}`]).catch(() => null);
        if (current !== null && current !== skillDocument(skill).trimEnd()) throw new ApiError(409, "任务技能快照已被修改，请审查后创建新任务。");
        if (current === null) changes.push({ path: skill.path, content: skillDocument(skill) });
      }
      if (changes.length) head = (await commitRepositoryFiles(projectId, actor, branch, head, "保存本任务的项目技能快照", changes)).commit;
    }
    return { branch, baseCommit: base, head };
  });
}
