import "server-only";
import { Agent, Runner, tool, type Model, type ModelSettings } from "@openai/agents";
import { z } from "zod";
import { modelProviderData, packageResearchConfig } from "./model-settings";
import { modelPolicyFromConfig, resolveModelOutputTokens } from "./model-policy";
import { createModelProvider } from "./openai";
import { DatabaseSession } from "./sessions";
import { getContext } from "./research";
import { runResearchAgent } from "./agent";
import { PROJECT_AGENT_INSTRUCTIONS } from "./prompts";
import { ApiError, publicError } from "./errors";
import { db } from "./db";
import { appendEvent } from "./events";
import { ragEnabled } from "./rag/config";
import { saveSource } from "./rag/sources";
import { goalSchema } from "./validation";
import { PROJECT_AGENT_BUDGET, logModelUsage, summarizeModelUsage } from "./agent-budget";
import { createDelegationTool, dispatchTeamSubtasks } from "./team-agent";

export function createProjectAgent(model: string | Model, settings: ModelSettings, research: (request: string) => Promise<string>, researchAllowed = true, delegate?: (input: unknown) => Promise<string>, delegationAgents: { id: string; username: string }[] = []) {
  // Some compatible providers ignore parallel_tool_calls=false; run a workspace only once per turn.
  let researchRun: Promise<string> | undefined;
  let delegationRun: Promise<string> | undefined;
  return new Agent({
    name: "ScenarioForge Project Agent", model, instructions: PROJECT_AGENT_INSTRUCTIONS + (delegate ? "\n当前提供 delegate_tasks，可在预算内派发团队子任务并审核返回结果。" : "\n当前未提供 delegate_tasks，不得声称已派发下游任务。"),
    modelSettings: { ...settings, maxTokens: settings.maxTokens ?? PROJECT_AGENT_BUDGET.maxOutputTokens, parallelToolCalls: false, retry: { maxRetries: 0 } },
    tools: [...(researchAllowed ? [tool({
      name: "run_research",
      description: "Research or update the current Markdown workspace only when requested. Pass the full current task, including relevant user constraints. Existing plans are reused; a different research topic needs a new conversation. Does not run while clarification or editing is blocked.",
      parameters: z.object({ request: goalSchema }),
      errorFunction: null,
      execute: ({ request }) => researchRun ??= research(request),
    })] : []), ...(delegate ? [createDelegationTool(input => delegationRun ??= delegate(input), delegationAgents)] : [])],
    toolUseBehavior: { stopAtToolNames: ["run_research"] },
  });
}

export async function prepareResearchTurn(packageId: string, request: string) {
  const goal = goalSchema.parse(request);
  return db.$transaction(async tx => {
    const current = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId }, include: { _count: { select: { files: true, evidence: true } } } });
    const blocking = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
    const locked = await tx.workspaceFile.count({ where: { packageId, lockedBy: { not: null } } });
    if (blocking || locked || ["waiting_for_user", "blocked", "waiting_for_edit"].includes(current.status)) return false;
    const initial = !current.researchPlan && !current._count.files && !current._count.evidence;
    await tx.researchPackage.update({ where: { id: packageId }, data: {
      ...(initial ? { goal, title: goal.slice(0, 60) } : {}), status: "researching", currentStage: Math.max(1, current.currentStage),
    } });
    if (initial && ragEnabled()) await saveSource(tx, packageId, { sourceType: "upload", sourceKey: "goal", title: "用户目标与约束", content: `${goal}\n\n${current.constraints ?? "{}"}`, metadata: { origin: "user_goal", trust: "user_provided" } });
    await appendEvent(tx, packageId, "research_started", initial ? "研究任务已启动" : "研究继续");
    return true;
  });
}

export async function runProjectAgent(packageId: string, message: string, signal: AbortSignal) {
  const env = await packageResearchConfig(packageId);
  const context = await getContext(packageId);
  const researchAllowed = !["waiting_for_user", "blocked", "waiting_for_edit"].includes(context.status)
    && !context.clarifications.some(question => question.priority === "blocking" && ["waiting", "blocked"].includes(question.status))
    && !context.files.some(file => file.lockedBy);
  const provider = createModelProvider(env);
  const runId = env.AGENT_RUN_ID;
  const projectId = (await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, select: { projectId: true } })).projectId;
  const memberDeliveries = await db.agentSubtask.findMany({ where: { packageId, status: "submitted" }, orderBy: { finishedAt: "desc" }, take: 10, select: { id: true, objective: true, assigneeName: true, result: true, finishedAt: true } });
  const delegationAgents = env.PROJECT_MODEL_CONFIG && runId && projectId ? await db.projectMember.findMany({
    where: { projectId, acceptsAgentTasks: true, personalAgentConfigEncrypted: { not: null } },
    select: { userId: true, user: { select: { username: true } } }, orderBy: { createdAt: "asc" },
  }).then(members => members.map(member => ({ id: member.userId, username: member.user.username }))) : [];
  const delegate = delegationAgents.length && runId
    ? (input: unknown) => dispatchTeamSubtasks({ packageId, runId, input, signal })
    : undefined;
  let usedResearch = false;
  const agent = createProjectAgent(env.SCENARIOFORGE_MODEL, {
    providerData: modelProviderData(modelPolicyFromConfig(env)),
    maxTokens: resolveModelOutputTokens(modelPolicyFromConfig(env), PROJECT_AGENT_BUDGET.maxOutputTokens),
  }, async request => {
    if (!await prepareResearchTurn(packageId, request)) return "研究仍在等待澄清答案或文件解锁。可以继续聊天；请先在澄清卡片提交答案，或保存/取消编辑，再继续研究。";
    usedResearch = true;
    try { return await runResearchAgent(packageId, request, signal); }
    catch (error) { throw new ApiError(502, publicError(error)); }
  }, researchAllowed, delegate, delegationAgents);
  try {
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true, traceIncludeSensitiveData: false });
    const result = await runner.run(agent, `当前研究包 ID：${packageId}\n` + JSON.stringify({ message, context: {
      goal: context.goal, constraints: context.constraints, status: context.status,
      researchPlan: context.researchPlan, clarifications: context.clarifications,
      files: context.files.map(({ filename, content, version, lockedBy }) => ({ filename, content, version, lockedBy })),
      uploadedFiles: context.uploadedFiles, evidence: context.evidence,
    }, memberDeliveries, delegationAgents: delegationAgents.map(({ id, username }) => ({ id, username })) }), { session: new DatabaseSession(packageId, context.sessionId), maxTurns: PROJECT_AGENT_BUDGET.maxTurns, signal });
    logModelUsage(packageId, "project_agent", summarizeModelUsage(result.rawResponses));
    return { summary: result.finalOutput ?? "本轮处理已结束。", usedResearch };
  } catch (error) {
    if (error instanceof Error) {
      error.message = error.message.split(env.OPENAI_API_KEY).join("[REDACTED]");
      if (error.stack) error.stack = error.stack.split(env.OPENAI_API_KEY).join("[REDACTED]");
    }
    throw error;
  } finally { await provider.close().catch(() => {}); }
}
