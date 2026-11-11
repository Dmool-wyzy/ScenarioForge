import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const markerPattern = /LOCAL_JOINT_SKILL_[a-f0-9]+/g;
const sourcePath = "src/calc.mjs";
const reportPath = "docs/REPORT.md";

function structuredValues(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    try { return structuredValues(JSON.parse(value), depth + 1); }
    catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => structuredValues(item, depth + 1));
  if (typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(item => structuredValues(item, depth + 1))];
}

function parseOutput(output) {
  const values = structuredValues(output);
  return values.find(value => typeof value.head === "string" || typeof value.commit === "string" || typeof value.content === "string") ?? values[0];
}

function responseBody(model, choice) {
  const callId = "call_" + randomUUID();
  return {
    id: "resp_" + randomUUID(), object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", error: null, model, parallel_tool_calls: false,
    output: choice.name ? [{ type: "function_call", id: "fc_" + randomUUID(), call_id: callId,
      name: choice.name, arguments: JSON.stringify(choice.args), status: "completed" }]
      : [{ type: "message", id: "msg_" + randomUUID(), role: "assistant", status: "completed",
        content: [{ type: "output_text", text: choice.text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

/**
 * Loopback-only wire fixture; it has no filesystem, database, or provider access.
 * @param {{ planWorkflow?: boolean, marker?: string }} [options]
 */
export async function createLocalWorkspaceModelServer(options = {}) {
  const requests = [], states = new Map(), responses = new Map();
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST", "The fixture only accepts model POST requests.");
      assert.equal(request.url, "/v1/responses", "The fixture only supports the Responses endpoint.");
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 2_000_000, "Fixture request exceeded the size limit.");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.stream ?? false, false, "The fixture requires non-streaming requests.");
      const values = structuredValues(body.input);
      const toolNames = (body.tools ?? []).map(tool => tool.name ?? tool.function?.name).filter(name => typeof name === "string");
      if (options.planWorkflow && !toolNames.length) {
        assert.equal(body.text?.format?.type, "json_schema", "Plan generation must request structured output.");
        const context = values.find(value => typeof value.request === "string" && typeof value.goal === "string");
        assert.ok(context && options.marker && context.goal.includes(options.marker), "Plan generation must receive the actual test goal.");
        assert.equal(requests.filter(item => item.kind === "documents").length, 0, "Document generation must make only one model call.");
        requests.push({ number: requests.length + 1, kind: "documents", toolNames: [], requestedTool: null });
        const legacy = {
          plan: ["# Addition repair plan", "", options.marker, "", "## Confirmed scope",
            "Read the current src/calc.mjs, repair add(a,b) using basic arithmetic, and save docs/REPORT.md.",
            "Preserve tests/calc.test.mjs, notes.md and unrelated user files. Do not import dependencies.",
            "Copy the skill marker into the report. Use verify_workspace and review_changes after saving.",
            "No network, shell command, commit or push is requested. This document records a proposed plan only."].join("\n"),
          tasks: ["# Execution and review tasks", "", options.marker, "",
            "- Read every selected skill and the current source before editing.",
            "- Correct addition for positive, negative, zero and decimal operands.",
            "- Save src/calc.mjs and docs/REPORT.md; preserve existing tests and notes.",
            "- Run static syntax verification and review the resulting file differences.",
            "- Do not claim the Agent ran tests; a separate trusted harness runs node --test tests/calc.test.mjs."].join("\n"),
        };
        const selectedDocuments = values.find(value => Array.isArray(value.confirmedDocuments))?.confirmedDocuments;
        assert.ok(selectedDocuments?.length >= 3, "The joint acceptance must generate the user-confirmed variable set.");
        const result = responseBody(body.model, { text: JSON.stringify({ documents: selectedDocuments.map(document => ({ filename: document.filename,
          content: document.filename === "PLAN.md" ? legacy.plan : document.filename === "TASKS.md" ? legacy.tasks
            : ["# Independent verification guide", "", options.marker, "", "Preserve the existing tests. Static syntax checks are separate from real test execution.",
              "Review actual changes and record unverified assumptions. Only a trusted harness runs the tests in this acceptance."].join("\n") })) }) });
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(result));
        return;
      }
      const initial = values.find(value => typeof value.request === "string" && typeof value.branch === "string" && Array.isArray(value.skills));
      let state = initial ? states.get(initial.branch) : responses.get(body.previous_response_id);
      if (!state) {
        assert.ok(initial, "The first model request must contain the workspace task context.");
        assert.ok(initial.skills.length > 0, "The joint acceptance task must select a skill.");
        state = { initial, calls: new Map(), results: new Map(), count: 0 };
        states.set(initial.branch, state);
      }
      assert.ok(++state.count <= 24, "The fixture task exceeded 24 model requests.");
      const record = { number: requests.length + 1, kind: "execution", toolNames: [...toolNames], requestedTool: null };
      requests.push(record);
      for (const item of values) {
        if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
          state.calls.set(item.call_id, { name: item.name, args: JSON.parse(item.arguments) });
        }
      }
      for (const item of values) {
        if (item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
        const call = state.calls.get(item.call_id);
        assert.ok(call, "The model history contains an output without its tool call.");
        const result = parseOutput(item.output);
        assert.ok(result && typeof result === "object", "The workspace tool must return a structured result.");
        state.results.set(call.name + ":" + JSON.stringify(call.args), { ...call, result });
      }
      const resultFor = (name, predicate = () => true) => [...state.results.values()].reverse().find(item => item.name === name && predicate(item.args))?.result;
      const call = (name, args) => {
        assert.ok(toolNames.includes(name), "A required workspace tool is unavailable.");
        record.requestedTool = name;
        return { name, args };
      };
      let choice;
      const listed = resultFor("list_workspace");
      const unread = state.initial.skills.find(skill => !resultFor("read_skill", args => args.id === skill.id));
      const source = resultFor("read_file", args => args.path === sourcePath);
      const applied = resultFor("apply_changes");
      const verified = resultFor("verify_workspace");
      const reviewed = resultFor("review_changes");
      if (!listed) choice = call("list_workspace", { query: "" });
      else if (unread) choice = call("read_skill", { id: unread.id });
      else if (!source) choice = call("read_file", { path: sourcePath });
      else if (!applied) {
        assert.match(source.head, /^[a-f0-9]{40}$/, "A real file read must supply the write head.");
        assert.ok(typeof source.content === "string", "The source must be read before modifying it.");
        const markers = [...new Set(state.initial.skills.flatMap(skill => {
          const loaded = resultFor("read_skill", args => args.id === skill.id);
          assert.equal(loaded.id, skill.id, "Loaded skill identity must match the selected snapshot.");
          assert.ok(typeof loaded.content === "string", "The skill content must come from read_skill.");
          return loaded.content.match(markerPattern) ?? [];
        }))];
        assert.ok(markers.length > 0, "The read skill must contain the joint acceptance marker.");
        if (listed.files.some(file => file.path === reportPath) && !resultFor("read_file", args => args.path === reportPath)) {
          choice = call("read_file", { path: reportPath });
        } else {
          choice = call("apply_changes", { head: source.head, reason: "Apply the selected local workspace skill",
            changes: [
              { path: sourcePath, content: "export function add(a, b) { return a + b; }\n", delete: false },
              { path: reportPath, content: "# Local workspace acceptance\n\n" + markers.join("\n")
                + "\n\nUpdated the addition implementation in src/calc.mjs.\nStatic syntax checks only; no test command was executed.\n", delete: false },
            ] });
        }
      } else if (!verified) {
        assert.match(applied.commit, /^[a-f0-9]{40}$/, "The write must return the actual workspace version.");
        choice = call("verify_workspace", {});
      } else if (!reviewed) {
        assert.equal(verified.status, "passed", "The written JavaScript must pass static syntax checking.");
        assert.equal(verified.kind, "syntax", "The fixture validates syntax rather than a command.");
        choice = call("review_changes", {});
      } else {
        assert.equal(reviewed.head, verified.head, "Reviewed files and verification must have the same version.");
        assert.ok(reviewed.changedPaths.includes(sourcePath) && reviewed.changedPaths.includes(reportPath), "The review must contain both real changed files.");
        choice = { text: "已根据所选技能修复 src/calc.mjs 并生成 docs/REPORT.md，已审查文件差异。静态语法检查通过；未运行测试命令，也未提交或推送 Git。" };
      }
      const result = responseBody(body.model, choice);
      if (choice.name) state.calls.set(result.output[0].call_id, { name: choice.name, args: choice.args });
      responses.set(result.id, state);
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result));
    } catch {
      // Never echo request contents, authorization headers, or source text.
      response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: { message: "Local workspace model fixture rejected an unexpected request." } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: "http://127.0.0.1:" + address.port + "/v1",
    requests,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
