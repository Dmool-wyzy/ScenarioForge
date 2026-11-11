import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner, Usage, type Model } from "@openai/agents";
import { runWorkspaceAgent } from "../lib/workspace-agent/agent";

test("workspace function tools execute one at a time even when a model returns a batch", async () => {
  const head = "a".repeat(40);
  let active = 0, maximum = 0, listed = false, read = false, response = 0;
  const operation = async <T>(action: () => T): Promise<T> => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      return action();
    } finally { active--; }
  };
  const workspace = {
    branch: "work/alice/agent-concurrency",
    list: () => operation(() => {
      listed = true;
      return { head, files: [{ path: "README.md", mode: "100644", size: 4 }], total: 1 };
    }),
    read: (path: string) => operation(() => {
      read = true;
      return { path, head, content: "test" };
    }),
    diff: async () => ({ head, changedPaths: [], diff: "" }),
  };
  const model: Model = {
    async getResponse() {
      if (response++ === 0) return {
        usage: new Usage(),
        output: [
          { type: "function_call", callId: "call-list", name: "list_workspace", arguments: JSON.stringify({ query: "" }), status: "completed" },
          { type: "function_call", callId: "call-read", name: "read_file", arguments: JSON.stringify({ path: "README.md" }), status: "completed" },
        ],
      };
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };

  await runWorkspaceAgent({ model, runner: new Runner({ tracingDisabled: true }), workspace: workspace as never, skills: [],
    request: "Read the workspace", baseCommit: head, signal: new AbortController().signal,
    onProgress: async () => {}, onCheckpoint: async () => {},
  });

  assert.equal(listed, true);
  assert.equal(read, true);
  assert.equal(maximum, 1);
});
