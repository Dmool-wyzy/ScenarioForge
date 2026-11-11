import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { OpenAIProvider, Runner } from "@openai/agents";
import { modelResponseFetch } from "../lib/model-response";
import { modelProviderData } from "../lib/model-settings";
import type { ModelDiagnostic } from "../lib/model-diagnostics";
import type { ModelPolicySettings } from "../lib/model-policy";
import { publicError } from "../lib/errors";
import { runWorkspaceAgent } from "../lib/workspace-agent/agent";
import { workspaceModelOutputTokens } from "../lib/workspace-agent/model-budget";
import { modelDiagnosticProgress } from "../lib/workspace-agent/model-progress";
import { snapshotSkill } from "../lib/workspace-agent/skills";
import type { WorkspacePort } from "../lib/workspace-agent/port";

const privateText = "private-fixture-source-never-in-diagnostics";
const skill = snapshotSkill({ id: "skill-fixture", packageId: "package-fixture", filename: "PLAN.md", version: 1,
  content: `# Plan\nCreate a tiny add module. ${privateText}`, package: { title: "Fixture", researchPlan: null } });

async function fixture(policy: ModelPolicySettings, incomplete = false) {
  let head = "a".repeat(40), writes = 0;
  const files = new Map([["README.md", privateText]]), requests: Record<string, unknown>[] = [], diagnostics: ModelDiagnostic[] = [];
  const workspace: WorkspacePort = {
    branch: "local/fixture", local: true,
    list: async () => ({ head, total: files.size, files: [...files].map(([path, content]) => ({ path, mode: "100644", size: content.length })) }),
    read: async path => ({ path, head, content: files.get(path)! }),
    write: async (expected, changes) => {
      assert.equal(expected, head); writes++;
      for (const change of changes) if (change.delete) files.delete(change.path); else files.set(change.path, change.content!);
      head = "b".repeat(40); return { commit: head };
    },
    diff: async () => ({ head, changedPaths: writes ? ["src/add.mjs"] : [], diff: writes ? "export const add = (a, b) => a + b;" : "" }),
  };
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const turn = requests.length;
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.conversation, undefined);
    if (turn > 1 && policy.reasoningEffort === "high") {
      const history = body.input as { type: string; content?: unknown }[];
      assert.ok(history.some(item => item.type === "reasoning" && JSON.stringify(item.content).includes(privateText)));
      assert.ok(history.some(item => item.type === "function_call_output"));
    }
    const call = (name: string, args: unknown) => ({ type: "function_call", id: `fc-${turn}`, call_id: `call-${turn}`, name, arguments: JSON.stringify(args), status: "completed" });
    const action = turn === 1 ? call("list_workspace", { query: "" })
      : turn === 2 ? call("read_skill", { id: skill.id })
      : turn === 3 ? call("read_file", { path: "README.md" })
      : turn === 4 ? call("apply_changes", { head, reason: "Add module", changes: [{ path: "src/add.mjs", content: "export const add = (a, b) => a + b;\n", delete: false }] })
      : turn === 5 ? call("verify_workspace", {})
      : { type: "message", id: "msg-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Module saved; syntax passed. Runtime tests were not run.", annotations: [] }] };
    const failed = incomplete && turn === 4;
    const output = failed ? [{ type: "reasoning", id: `rs-${turn}`, content: [{ type: "reasoning_text", text: privateText }] }]
      : policy.reasoningEffort === "high" ? [{ type: "reasoning", id: `rs-${turn}`, content: [{ type: "reasoning_text", text: privateText }] }, action] : [action];
    return new Response(JSON.stringify({ id: `resp-${turn}`, object: "response", created_at: 1, model: "deepseek-v4-pro",
      status: failed ? "incomplete" : "completed", incomplete_details: failed ? { reason: "max_output_tokens" } : null,
      output, usage: { input_tokens: 100, output_tokens: failed ? body.max_output_tokens : 30,
        output_tokens_details: { reasoning_tokens: failed ? body.max_output_tokens : policy.reasoningEffort === "high" ? 10 : 0 }, total_tokens: failed ? body.max_output_tokens + 100 : 130 } }),
    { headers: { "content-type": "application/json" } });
  };
  const client = new OpenAI({ apiKey: "fixture-key-never-transmitted", baseURL: policy.baseUrl, timeout: 300000, maxRetries: 0,
    fetch: modelResponseFetch(transport, "responses", { onDiagnostic: diagnostic => { diagnostics.push(diagnostic); } }) });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  try {
    const execute = () => runWorkspaceAgent({ model: "deepseek-v4-pro", policy, settings: { providerData: modelProviderData(policy) },
      runner: new Runner({ modelProvider: provider, tracingDisabled: true }), workspace, skills: [skill], request: "Create add.mjs", baseCommit: head,
      signal: new AbortController().signal, onProgress: async () => {}, onCheckpoint: async () => {} });
    if (incomplete) {
      await assert.rejects(execute(), error => /输出.*上限.*截断/.test(publicError(error)));
      assert.equal(writes, 0, "Incomplete tool arguments must never modify files");
      assert.equal(requests.length, 4, "Incomplete output must not trigger an automatic retry");
      assert.equal(diagnostics.at(-1)?.incompleteReason, "max_output_tokens");
      assert.equal(diagnostics.at(-1)?.reasoningTokens, requests[3].max_output_tokens);
    } else {
      const result = await execute();
      assert.equal(result.verification.status, "passed"); assert.equal(writes, 1); assert.equal(requests.length, 6);
      assert.equal(files.get("src/add.mjs"), "export const add = (a, b) => a + b;\n");
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(`${privateText}|fixture-key|src/add`));
    return { requests, diagnostics };
  } finally { await provider.close(); }
}

test("real workspace SDK sends policy on every round, adapts budgets and retains reasoning history", async t => {
  for (const effort of ["auto", "high"] as const) await t.test(effort, async () => {
    const { requests } = await fixture({ baseUrl: "https://api.deepseek.com", apiMode: "responses", reasoningEffort: effort });
    for (const request of requests) {
      assert.deepEqual(request.reasoning, { effort: effort === "auto" ? "none" : "high" });
      assert.equal(request.thinking, undefined); assert.equal(request.stream, false);
    }
    assert.deepEqual(requests.map(request => request.max_output_tokens), effort === "auto"
      ? [8192, 8192, 16384, 16384, 8192, 8192] : [16384, 16384, 32768, 32768, 16384, 16384]);
  });
});

test("manual output caps survive every workspace round and automatic thinking budgets", async () => {
  const { requests } = await fixture({ baseUrl: "https://api.deepseek.com", apiMode: "responses", reasoningEffort: "high", maxOutputTokens: 1024 });
  assert.ok(requests.every(request => request.max_output_tokens === 1024));
  assert.equal(workspaceModelOutputTokens({ baseUrl: "https://api.deepseek.com", apiMode: "responses", reasoningEffort: "none" }, "generate", 40000), 24576);
});

test("workspace SDK preserves safe exhausted-budget evidence and never executes incomplete tool calls", async () => {
  const { diagnostics } = await fixture({ baseUrl: "https://api.deepseek.com", apiMode: "responses", reasoningEffort: "high" }, true);
  const last = diagnostics.at(-1)!;
  const mapped = modelDiagnosticProgress(last, "attempt-a", 300, false);
  assert.match(mapped.message, /输出预算耗尽/); assert.equal(mapped.progress.model?.timeoutSeconds, 300);
  assert.equal(mapped.progress.model?.budgetMode, "auto"); assert.equal(mapped.progress.phase, "failed");
  assert.notEqual(mapped.progress.operationId, modelDiagnosticProgress(last, "attempt-b", 300, false).progress.operationId);
});
