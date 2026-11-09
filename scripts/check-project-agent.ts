import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner, ToolCallError, Usage, type Model } from "@openai/agents";
import { createProjectAgent, prepareResearchTurn } from "../lib/project-agent";
import { taskOutcome } from "../lib/task-outcome";
import { ApiError, publicError } from "../lib/errors";
import { db } from "../lib/db";
import { PROJECT_AGENT_INSTRUCTIONS } from "../lib/prompts";
import { goalSchema } from "../lib/validation";
import { PROJECT_AGENT_BUDGET, RESEARCH_AGENT_BUDGET, summarizeModelUsage } from "../lib/agent-budget";

// This suite uses the real Runner with a deterministic model and an in-memory transaction.
process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/scenarioforge_test_unused";
process.env.RAG_ENABLED = "false";

test("dispatch cost review reuses the top-level turn and does not claim unavailable agents", () => {
  assert.match(PROJECT_AGENT_INSTRUCTIONS, /不要为了估算成本再调用一次模型或工具/);
  assert.match(PROJECT_AGENT_INSTRUCTIONS, /至少两项目标明确、可独立交付/);
  assert.match(PROJECT_AGENT_INSTRUCTIONS, /不得复制完整对话、全部项目文件或个人资料/);
  assert.match(PROJECT_AGENT_INSTRUCTIONS, /没有 delegate_tasks 工具时，不得声称已派发/);
  assert.equal(PROJECT_AGENT_BUDGET.maxTurns, 3);
  assert.equal(RESEARCH_AGENT_BUDGET.maxTurns, 24);
  assert.deepEqual(summarizeModelUsage([
    { usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 4, totalTokens: 14 }) },
    { usage: new Usage({ requests: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 }) },
  ]), { requests: 2, inputTokens: 17, outputTokens: 7, totalTokens: 24, tokenUsageResponses: 2 });
});

function reply(text: string) {
  return { usage: new Usage(), output: [{ type: "message" as const, role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text }] }] };
}

test("short chat responds without a research tool or workspace", async () => {
  let researchCalls = 0;
  let delegationToolAvailable = true;
  const model: Model = {
    async getResponse(input) { delegationToolAvailable = input.tools.some(tool => tool.type === "function" && tool.name === "delegate_tasks"); return reply("你好，可以聊天、讨论任务，或按需研究。"); },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const agent = createProjectAgent(model, {}, async () => { researchCalls++; throw new Error("MCP unavailable"); });
  assert.equal(agent.modelSettings.maxTokens, PROJECT_AGENT_BUDGET.maxOutputTokens);
  const result = await new Runner({ tracingDisabled: true }).run(agent, goalSchema.parse("你好"));
  assert.match(result.finalOutput ?? "", /你好/);
  assert.equal(researchCalls, 0);
  assert.equal(delegationToolAvailable, false, "A server fallback model must not be exposed as the team subagent.");
  assert.deepEqual(taskOutcome({ status: "created", currentStage: 0, researchPlan: null }, false, []), { status: "replied", currentStage: 0 });
  assert.deepEqual(taskOutcome({ status: "failed", currentStage: 0, researchPlan: null }, false, []), { status: "replied", currentStage: 0 });
});

test("research receives the current request and duplicate tool calls execute only once", async () => {
  let calls = 0;
  const requestText = "只研究两个问题，并生成三份 Markdown 文档";
  const model: Model = {
    async getResponse() { return { usage: new Usage(), output: ["one", "two"].map(callId => ({ type: "function_call" as const, callId, name: "run_research", arguments: JSON.stringify({ request: requestText }), status: "completed" as const })) }; },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const agent = createProjectAgent(model, {}, async request => { calls++; assert.equal(request, requestText); return "三份文档已保存"; });
  const result = await new Runner({ tracingDisabled: true }).run(agent, requestText);
  assert.equal(calls, 1);
  assert.equal(result.finalOutput, "三份文档已保存");
});

test("research failure stops the outer Runner with the safe reason", async () => {
  let calls = 0;
  const model: Model = {
    async getResponse() { calls++; return { usage: new Usage(), output: [{ type: "function_call", callId: "one", name: "run_research", arguments: JSON.stringify({ request: "研究当前项目" }), status: "completed" }] }; },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const agent = createProjectAgent(model, {}, async () => { throw new ApiError(502, "研究计划格式不符合要求，本轮已停止。"); });
  await assert.rejects(new Runner({ tracingDisabled: true }).run(agent, "研究当前项目"), error => {
    assert.ok(error instanceof ToolCallError);
    assert.match(publicError(error), /研究计划格式/);
    return true;
  });
  assert.equal(calls, 1);
});

test("research waits remove the tool so chat cannot be routed back into research", async () => {
  let sawResearchTool = true;
  const model: Model = {
    async getResponse(input) {
      sawResearchTool = input.tools.some(tool => tool.type === "function" && tool.name === "run_research");
      return reply("最小可演示版本是能稳定展示核心流程的最小实现。");
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const agent = createProjectAgent(model, {}, async () => { throw new Error("research must be unavailable while waiting"); }, false);
  const result = await new Runner({ tracingDisabled: true }).run(agent, "等待时请解释 MVP");
  assert.equal(sawResearchTool, false);
  assert.match(result.finalOutput ?? "", /最小可演示版本/);
});

test("delegated work reports waiting for member confirmation without a private draft", async () => {
  const observations: string[] = [];
  let modelCalls = 0;
  const model: Model = {
    async getResponse(input) {
      modelCalls++;
      if (modelCalls === 1) {
        assert.ok(input.tools.some(tool => tool.type === "function" && tool.name === "delegate_tasks"));
        return { usage: new Usage(), output: [{ type: "function_call" as const, callId: "subtask-batch", name: "delegate_tasks", arguments: JSON.stringify({ tasks: [{ objective: "分析方案甲", context: "甲的必要背景", assigneeId: "member-a" }, { objective: "分析方案乙", context: "乙的必要背景", assigneeId: "member-b" }] }), status: "completed" as const }] };
      }
      observations.push(JSON.stringify(input.input));
      return reply("两个子任务已派发，等待成员确认提交。");
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  let dispatched = 0;
  const agents = [{ id: "member-a", username: "alpha" }, { id: "member-b", username: "beta" }];
  const agent = createProjectAgent(model, {}, async () => "unused", true, async input => {
    dispatched++;
    assert.deepEqual(input, { tasks: [{ objective: "分析方案甲", context: "甲的必要背景", assigneeId: "member-a" }, { objective: "分析方案乙", context: "乙的必要背景", assigneeId: "member-b" }] });
    return JSON.stringify({ tasks: [{ objective: "分析方案甲", status: "review" }, { objective: "分析方案乙", status: "review" }] });
  }, agents);
  const result = await new Runner({ tracingDisabled: true }).run(agent, "比较两个独立方案", { maxTurns: PROJECT_AGENT_BUDGET.maxTurns });
  assert.equal(dispatched, 1);
  assert.equal(modelCalls, 2);
  assert.match(result.finalOutput ?? "", /等待成员确认/);
  assert.match(observations[0], /review/);
  assert.doesNotMatch(observations[0], /甲结论|乙结论/);
  assert.deepEqual(agent.toolUseBehavior, { stopAtToolNames: ["run_research"] });
});

test("chat preserves existing research status and actual research still requires every planned file", () => {
  const names = ["README.md", "RESEARCH.md", "SOURCES.md"];
  const plan = JSON.stringify({ filePlan: names.map(filename => ({ filename, purpose: "测试", priority: "required", contentOutline: ["测试"] })) });
  for (const status of ["replied", "failed", "completed", "waiting_for_user", "blocked", "waiting_for_edit"]) {
    assert.deepEqual(taskOutcome({ status, currentStage: 2, researchPlan: plan }, false, []), { status, currentStage: 2 });
  }
  assert.throws(() => taskOutcome({ status: "researching", currentStage: 1, researchPlan: null }, true, []), /计划尚未成功保存/);
  assert.throws(() => taskOutcome({ status: "researching", currentStage: 2, researchPlan: plan }, true, names.slice(0, 2)), /SOURCES.md/);
  assert.deepEqual(taskOutcome({ status: "researching", currentStage: 2, researchPlan: plan }, true, names), { status: "completed", currentStage: 4 });
  assert.deepEqual(taskOutcome({ status: "waiting_for_user", currentStage: 3, researchPlan: plan }, true, []), { status: "waiting_for_user", currentStage: 3 });
});

test("first research replaces the chat greeting, existing research and blockers are preserved", async () => {
  let current = { goal: "你好", constraints: "{}", status: "replied", currentStage: 0, researchPlan: null as string | null, _count: { files: 0, evidence: 0 } };
  let blocking = 0, locked = 0;
  const updates: Record<string, unknown>[] = [];
  const tx = {
    researchPackage: {
      findUniqueOrThrow: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return { eventSequence: 1 }; },
    },
    clarification: { count: async () => blocking },
    workspaceFile: { count: async () => locked },
    researchEvent: { create: async () => ({}) },
  };
  const transaction = db.$transaction;
  db.$transaction = (async (fn: (value: typeof tx) => unknown) => fn(tx)) as unknown as typeof db.$transaction;
  try {
    assert.equal(await prepareResearchTurn("owned-package", "研究两个具体问题"), true);
    assert.equal(updates[0].goal, "研究两个具体问题");
    current = { ...current, goal: "已有研究", researchPlan: "{}", _count: { files: 3, evidence: 1 } };
    updates.length = 0;
    assert.equal(await prepareResearchTurn("owned-package", "解释已有研究"), true);
    assert.equal("goal" in updates[0], false);
    for (const cause of ["blocking", "locked", "status"]) {
      blocking = cause === "blocking" ? 1 : 0;
      locked = cause === "locked" ? 1 : 0;
      current.status = cause === "status" ? "waiting_for_user" : "replied";
      updates.length = 0;
      assert.equal(await prepareResearchTurn("owned-package", "继续研究"), false);
      assert.equal(updates.length, 0);
    }
  } finally { db.$transaction = transaction; }
});
