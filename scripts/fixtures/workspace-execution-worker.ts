import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@openai/agents";
import type { SkillFile } from "../../lib/workspace-agent/types";

// This subprocess belongs exclusively to check-workspace-agent-db.ts. Validate
// its explicit test target before importing anything that can open a database.
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "Worker fixture requires an explicit isolated test database.");
assert.ok(process.env.DATABASE_URL === databaseUrl, "Worker fixture refuses a mismatched DATABASE_URL.");
const target = new URL(databaseUrl);
assert.ok(target.protocol === "mysql:" && /^\/scenarioforge_test_[a-z0-9_]{1,45}$/i.test(target.pathname), "Worker fixture refuses a database outside the test namespace.");
const [id, marker] = process.argv.slice(2);
assert.ok(id && /^[A-Za-z0-9_-]{1,100}$/.test(id), "Missing or invalid fixture task ID.");
assert.ok(marker && /^SCENARIOFORGE_WORKER_CHECKPOINT:[a-f0-9]{24}$/.test(marker), "Missing fixture checkpoint marker.");
const root = process.env.SCENARIOFORGE_GIT_ROOT;
assert.ok(root && path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("sf-execution-db-test-"), "Worker fixture requires its parent's temporary repository root.");
process.env.SCENARIOFORGE_ENV_FILE = "";
process.env.SCENARIOFORGE_TASK_SCHEDULER = "off";
process.env.RAG_ENABLED = "false";
globalThis.fetch = async () => { throw new Error("Worker fixture forbids all HTTP/model service requests."); };

async function main() {
  const [{ db }, { Usage }, { executeWorkspaceExecution }, { AgentWorkspace }] = await Promise.all([
    import("../../lib/db"), import("@openai/agents"), import("../../lib/workspace-agent/jobs"), import("../../lib/workspace-agent/workspace"),
  ]);
  try {
    await executeWorkspaceExecution(id, async run => {
      const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: run.packageId }, select: { projectId: true } });
      assert.ok(pkg.projectId);
      const actor = await db.user.findUniqueOrThrow({ where: { id: run.createdBy }, select: { id: true, username: true } });
      assert.ok(run.branch);
      const work = new AgentWorkspace(pkg.projectId, run.branch, { ...actor, owner: false });
      const skills = JSON.parse(run.skills) as SkillFile[];
      let step = 0;
      const call = (name: string, args: unknown, ordinal: number) => ({ usage: new Usage(), output: [{ type: "function_call" as const,
        callId: `worker-fixture-${ordinal}`, name, arguments: JSON.stringify(args), status: "completed" as const }] });
      const model: Model = {
        async getResponse() {
          const ordinal = step++;
          if (ordinal === 0) return call("list_workspace", { query: "" }, ordinal);
          if (ordinal <= skills.length) return call("read_skill", { id: skills[ordinal - 1].id }, ordinal);
          if (ordinal === skills.length + 1) return call("apply_changes", { head: (await work.list()).head, reason: "保存进程重启验收文件",
            changes: [{ path: "src/restarted.ts", content: "export const recoveredAfterRestart = true;", delete: false }] }, ordinal);
          // The next model turn begins only after apply_changes and its durable
          // database checkpoint have both returned through the real SDK runner.
          const saved = await db.workspaceExecution.findUniqueOrThrow({ where: { id } });
          const file = await work.read("src/restarted.ts");
          assert.equal(saved.head, file.head); assert.equal(saved.status, "running");
          assert.ok(await db.researchEvent.count({ where: { packageId: run.packageId, type: "execution_checkpoint" } }));
          await new Promise<void>((resolve, reject) => { process.stdout.write(`${marker}\n`, error => error ? reject(error) : resolve()); });
          return await new Promise<never>(() => { /* Parent deliberately terminates this process. */ });
        },
        getStreamedResponse() { throw new Error("unused"); },
      };
      return { model };
    });
    throw new Error("Worker fixture ended before the parent terminated it at its checkpoint.");
  } finally { await db.$disconnect(); }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message.split(databaseUrl!).join("[test database]") : "Worker fixture failed.");
  process.exitCode = 1;
});
