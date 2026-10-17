import "server-only";
import { Agent, Runner } from "@openai/agents";
import { getResearchConfig } from "./env";
import { createModelProvider } from "./openai";
import { DatabaseSession } from "./sessions";
import { getContext } from "./research";
import { RESEARCH_PLANNER_INSTRUCTIONS } from "./prompts";
import { ApiError } from "./errors";
import { db } from "./db";
import { ScopedMcpServer } from "./research-mcp";
import { emitEvent } from "./events";
import { searchProviderName } from "./search/index";
import { ragEnabled, embeddingConfig } from "./rag/config";

export async function runResearchAgent(packageId: string, message: string, signal: AbortSignal) {
  if (ragEnabled()) embeddingConfig();
  const env = getResearchConfig();
  const context = await getContext(packageId);
  const mcp = new ScopedMcpServer(packageId, env.SCENARIOFORGE_MCP_URL,
    (type, message, payload) => emitEvent(packageId, type, message, payload));
  const provider = createModelProvider();
  try {
    try { await mcp.connect(); }
    catch { throw new ApiError(503, "无法连接 MCP Server，请先启动 Python MCP 服务。"); }
    const agent = new Agent({
      name: "ScenarioForge Research Planner",
      instructions: async () => {
        const latest = await getContext(packageId);
        return RESEARCH_PLANNER_INSTRUCTIONS + `\n当前研究包 ID：${packageId}\n当前搜索 Provider：${searchProviderName()}。真实搜索模式下，历史 Mock 证据不能作为已完成真实检索的依据。\n已完成的研究问题：${JSON.stringify(latest.searchedQuestions)}\n最新上下文版本：${latest.contextVersion}\n最新文件计划：${JSON.stringify(latest.researchPlan?.filePlan ?? [])}\n最新澄清答案：${JSON.stringify(latest.clarifications)}\n最新文件版本：${JSON.stringify(latest.files.map((f) => ({ filename: f.filename, version: f.version, updatedBy: f.updatedBy, lockedBy: f.lockedBy })))}\n涉及用户修改文件时必须再次 read_workspace_file。`;
      },
      model: env.SCENARIOFORGE_MODEL,
      modelSettings: { parallelToolCalls: false, retry: { maxRetries: 0 } },
      mcpServers: [mcp],
      mcpConfig: { convertSchemasToStrict: true },
      toolUseBehavior: async () => {
        const row = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, select: { status: true } });
        if (["waiting_for_user", "blocked", "waiting_for_edit"].includes(row.status)) return { isFinalOutput: true, isInterrupted: undefined, finalOutput: "研究已暂停，等待用户补充或完成文件编辑。" };
        return { isFinalOutput: false, isInterrupted: undefined };
      },
    });
    if (!ragEnabled()) for (const file of context.files.filter((f) => f.userModified)) await mcp.callToolResult("read_workspace_file", { package_id: packageId, filename: file.filename });
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true, traceIncludeSensitiveData: false });
    const bounded = ragEnabled() ? { uploadedFiles: context.uploadedFiles.map((file: { filename: string }) => ({ filename: file.filename })), evidenceCount: context.evidence.length, files: context.files.map(({ filename, version, updatedBy, lockedBy }) => ({ filename, version, updatedBy, lockedBy })), ragEnabled: true } : { uploadedFiles: context.uploadedFiles, evidence: context.evidence, files: context.files };
    const result = await runner.run(agent, JSON.stringify({ message, context: { goal: context.goal, constraints: context.constraints, researchPlan: context.researchPlan, searchedQuestions: context.searchedQuestions, clarifications: context.clarifications, contextVersion: context.contextVersion, ...bounded } }), { session: new DatabaseSession(packageId, context.sessionId), maxTurns: 24, signal });
    return result.finalOutput ?? "本轮研究已结束。";
  } finally {
    await mcp.close().catch(() => {});
    await provider.close().catch(() => {});
  }
}
