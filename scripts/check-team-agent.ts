import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner, Usage, type Model } from "@openai/agents";
import { ApiError } from "../lib/errors";
import { db } from "../lib/db";
import { TEAM_SUBTASK_BUDGET } from "../lib/agent-budget";
import { createTeamSubagent, delegatedTasksSchema, reserveAgentSubtasks } from "../lib/team-agent";

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/scenarioforge_test_unused";

test("team subtask input is narrow, bounded, and rejects duplicate objectives", () => {
  assert.deepEqual(delegatedTasksSchema.parse({ tasks: [{ objective: "检查 A", assigneeId: "member-a" }] }), { tasks: [{ objective: "检查 A", context: "", assigneeId: "member-a" }] });
  assert.throws(() => delegatedTasksSchema.parse({ tasks: [{ objective: "重复", assigneeId: "member-a" }, { objective: " 重复 ", assigneeId: "member-b" }] }), /不能重复/);
  assert.throws(() => delegatedTasksSchema.parse({ tasks: Array.from({ length: 3 }, (_, i) => ({ objective: `任务 ${i}`, assigneeId: "member-a" })) }), /Too big/);
  assert.throws(() => delegatedTasksSchema.parse({ tasks: [{ objective: "目标", assigneeId: "member-a", context: "x".repeat(TEAM_SUBTASK_BUDGET.maxContextChars + 1) }] }), /Too big/);
  assert.throws(() => delegatedTasksSchema.parse({ tasks: [{ objective: "未选择接收人" }] }), /assigneeId/);
});

test("team subagent makes one tool-free bounded model call", async () => {
  let calls = 0;
  const model: Model = {
    async getResponse(input) {
      calls++;
      assert.deepEqual(input.tools, []);
      return { usage: new Usage({ requests: 1, inputTokens: 20, outputTokens: 8, totalTokens: 28 }), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "分析结论" }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const worker = createTeamSubagent(model, {});
  assert.equal(worker.modelSettings.maxTokens, TEAM_SUBTASK_BUDGET.maxOutputTokensPerTask);
  const result = await new Runner({ tracingDisabled: true }).run(worker, JSON.stringify({ objective: "分析一个方案", context: "只读背景" }), { maxTurns: TEAM_SUBTASK_BUDGET.maxTurnsPerTask });
  assert.equal(calls, 1);
  assert.equal(result.finalOutput, "分析结论");
});

test("subtask slots are reserved atomically against the active package lease", async () => {
  let current = { projectId: "project-one", taskState: "running", leaseOwner: "lease-one", leaseUntil: new Date(Date.now() + 60_000), agentTaskCount: 0, eventSequence: 0 };
  const eligibleIds = new Set(["member-a", "member-b"]);
  const created: { id: string; packageId: string; ordinal: number; objective: string; context: string; assigneeId: string; assigneeName: string }[] = [];
  const tx = {
    researchPackage: {
      findUnique: async () => ({ ...current }),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { agentTaskCount?: { increment: number } } }) => {
        const leaseUntil = where.leaseUntil as { gt: Date } | undefined;
        if (where.leaseOwner !== current.leaseOwner || where.taskState !== current.taskState || where.agentTaskCount !== current.agentTaskCount || !leaseUntil || current.leaseUntil <= leaseUntil.gt) return { count: 0 };
        current = { ...current, agentTaskCount: current.agentTaskCount + (data.agentTaskCount?.increment ?? 0) };
        return { count: 1 };
      },
      update: async () => ({ eventSequence: ++current.eventSequence }),
    },
    projectMember: { findMany: async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.filter(userId => eligibleIds.has(userId)).map(userId => ({ userId, acceptsAgentTasks: true, personalAgentConfigEncrypted: "fixture", user: { username: userId } })) },
    agentSubtask: { create: async ({ data }: { data: { packageId: string; ordinal: number; objective: string; context: string; assigneeId: string; assigneeName: string } }) => { const row = { id: `subtask-${data.ordinal}`, ...data }; created.push(row); return row; } },
    researchEvent: { create: async () => ({}) },
  };
  const original = db.$transaction;
  db.$transaction = (async (callback: (value: typeof tx) => unknown) => callback(tx)) as unknown as typeof db.$transaction;
  try {
    const rows = await reserveAgentSubtasks("package-one", "lease-one", { tasks: [{ objective: "任务甲", assigneeId: "member-a" }, { objective: "任务乙", assigneeId: "member-b" }] });
    assert.deepEqual(rows.map(row => row.ordinal), [1, 2]);
    assert.equal(current.agentTaskCount, TEAM_SUBTASK_BUDGET.maxTasksPerRun);
    await assert.rejects(reserveAgentSubtasks("package-one", "lease-one", { tasks: [{ objective: "任务丙", assigneeId: "member-a" }] }), error => error instanceof ApiError && error.status === 429);
    current = { ...current, agentTaskCount: 0 };
    await assert.rejects(reserveAgentSubtasks("package-one", "lease-one", { tasks: [{ objective: "项目外成员", assigneeId: "outsider" }] }), error => error instanceof ApiError && error.status === 409);
    eligibleIds.delete("member-b");
    await assert.rejects(reserveAgentSubtasks("package-one", "lease-one", { tasks: [{ objective: "已关闭接收", assigneeId: "member-b" }] }), error => error instanceof ApiError && error.status === 409);
    current = { ...current, leaseOwner: "lease-two" };
    await assert.rejects(reserveAgentSubtasks("package-one", "lease-one", { tasks: [{ objective: "过期任务", assigneeId: "member-a" }] }), error => error instanceof ApiError && error.status === 409);
    assert.equal(created.length, 2);
  } finally { db.$transaction = original; }
});
