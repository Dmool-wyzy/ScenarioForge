export const PROJECT_AGENT_BUDGET = { maxTurns: 3, maxOutputTokens: 6144 } as const;
export const RESEARCH_AGENT_BUDGET = { maxTurns: 24, maxToolCalls: 44, maxOutputTokens: 2048 } as const;
export const TEAM_SUBTASK_BUDGET = { maxTasksPerRun: 2, maxTurnsPerTask: 1, maxOutputTokensPerTask: 2048, maxObjectiveChars: 1500, maxContextChars: 4000, maxResultChars: 12000 } as const;
export const TASK_RUNTIME_MS = 20 * 60_000;

type ResponseUsage = { requests?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
type ModelResponseUsage = { usage?: ResponseUsage };

export function summarizeModelUsage(responses: ModelResponseUsage[]) {
  return responses.reduce((total, response) => ({
    requests: total.requests + (response.usage?.requests ?? 0),
    inputTokens: total.inputTokens + (response.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (response.usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + (response.usage?.totalTokens ?? 0),
    tokenUsageResponses: total.tokenUsageResponses + Number((response.usage?.inputTokens ?? 0) > 0 || (response.usage?.outputTokens ?? 0) > 0 || (response.usage?.totalTokens ?? 0) > 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenUsageResponses: 0 });
}

export function logModelUsage(packageId: string, agent: string, usage: ReturnType<typeof summarizeModelUsage>) {
  console.info(JSON.stringify({ event: "model_usage", packageId, agent, ...usage }));
}
