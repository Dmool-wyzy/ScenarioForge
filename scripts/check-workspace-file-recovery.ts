import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner, Usage, type Model } from "@openai/agents";
import { ApiError, publicError } from "../lib/errors";
import { runWorkspaceAgent } from "../lib/workspace-agent/agent";
import type { WorkspacePort } from "../lib/workspace-agent/port";
import { snapshotSkill } from "../lib/workspace-agent/skills";
import type { ExecutionProgress, SkillFile } from "../lib/workspace-agent/types";

type Request = Parameters<Model["getResponse"]>[0];
type Response = Awaited<ReturnType<Model["getResponse"]>>;
const initialReadme = "# Fixture\nKeep this user text.\n";

function call(turn: number, name: string, args: unknown): Response {
  return { usage: new Usage(), output: [{ type: "function_call", callId: `recovery-${turn}`, name,
    arguments: JSON.stringify(args), status: "completed" }] };
}
function finish(): Response {
  return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Finished the requested file changes." }] }] };
}
function change(path: string, content: string) { return { path, content, delete: false }; }
function toolResults(request: Request) {
  if (typeof request.input === "string") return [];
  return request.input.flatMap(item => {
    if (item.type !== "function_call_result") return [];
    const output = typeof item.output === "string" ? item.output : !Array.isArray(item.output) && item.output.type === "text" ? item.output.text : "";
    try { return [JSON.parse(output) as Record<string, unknown>]; } catch { return []; }
  });
}
function recovery(request: Request, code: "file_read_required" | "stale_head", head: string, requiredReads: string[]) {
  const result = toolResults(request).filter(item => item.recoverable === true).at(-1);
  assert.ok(result, "The next model round must receive structured recovery feedback");
  assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.head, head);
  assert.deepEqual(result.requiredReads, requiredReads);
  assert.equal(typeof result.message, "string"); assert.ok(String(result.message).length);
  assert.equal(typeof result.nextAction, "string"); assert.ok(String(result.nextAction).length);
  return result;
}

function fixture(options: { writeError?: ApiError; skills?: SkillFile[] } = {}) {
  const files = new Map([["README.md", initialReadme], ["src/calc.mjs", "export const add = (a, b) => a + b;\n"]]);
  let version = 1;
  const state = {
    head: version.toString(16).padStart(40, "0"), writes: 0, writeAttempts: 0, reads: [] as string[], stopped: false,
    checkpoints: [] as string[], progress: [] as { message: string; detail?: ExecutionProgress }[], requests: [] as Request[],
  };
  const assertActive = () => { if (state.stopped) throw new ApiError(409, "本地工作区任务已停止或执行租约结束。"); };
  const advance = () => { state.head = (++version).toString(16).padStart(40, "0"); };
  const workspace: WorkspacePort = {
    local: true, branch: "local/offline-file-recovery",
    async list() {
      assertActive();
      return { head: state.head, total: files.size, files: [...files].map(([path, content]) => ({ path, mode: "100644", size: content.length })) };
    },
    async read(path) {
      assertActive(); state.reads.push(path);
      assert.ok(files.has(path), `Fixture file must exist: ${path}`);
      return { path, head: state.head, content: files.get(path)! };
    },
    async write(head, changes) {
      assertActive(); state.writeAttempts++;
      if (options.writeError) throw options.writeError;
      assert.equal(head, state.head, "The backend compare-and-swap guard must remain intact");
      for (const item of changes) if (item.delete) files.delete(item.path); else files.set(item.path, item.content!);
      state.writes++; advance(); return { commit: state.head };
    },
    async diff() { assertActive(); return { head: state.head, changedPaths: state.writes ? ["README.md"] : [], diff: "Offline fixture diff" }; },
  };
  const baseCommit = state.head;
  return {
    files, state,
    externalEdit(path: string, content: string) { files.set(path, content); advance(); },
    run(program: (turn: number, request: Request) => Response | Promise<Response>) {
      const model: Model = {
        async getResponse(request) {
          state.requests.push({ ...request, input: JSON.parse(JSON.stringify(request.input)) });
          return program(state.requests.length, request);
        },
        getStreamedResponse() { throw new Error("Streaming is not used by this offline fixture"); },
      };
      return runWorkspaceAgent({ model, runner: new Runner({ tracingDisabled: true }), workspace, skills: options.skills ?? [],
        request: "Update README while preserving existing user text", baseCommit, signal: new AbortController().signal,
        onProgress: async (message, detail) => { state.progress.push({ message, detail }); },
        onCheckpoint: async head => { state.checkpoints.push(head); } });
    },
  };
}

test("unread README returns feedback to the real SDK and continues after an explicit read", async () => {
  const f = fixture();
  const result = await f.run((turn, request) => {
    if (turn === 1) return call(turn, "list_workspace", { query: "" });
    if (turn === 2) return call(turn, "apply_changes", { head: f.state.head, reason: "Update README", changes: [change("README.md", initialReadme + "Updated.\n")] });
    if (turn === 3) {
      recovery(request, "file_read_required", f.state.head, ["README.md"]);
      assert.equal(f.state.writes, 0); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.checkpoints.length, 0);
      assert.equal(f.files.get("README.md"), initialReadme);
      assert.ok(!f.state.progress.some(item => /已保存/.test(item.message)), "Rejected changes cannot appear as saved");
      return call(turn, "read_file", { path: "README.md" });
    }
    if (turn === 4) return call(turn, "apply_changes", { head: f.state.head, reason: "Preserve and update README", changes: [change("README.md", initialReadme + "Updated.\n")] });
    return finish();
  });
  assert.equal(f.state.requests.length, 5); assert.equal(f.state.writes, 1); assert.equal(f.state.writeAttempts, 1);
  assert.equal(f.files.get("README.md"), initialReadme + "Updated.\n"); assert.equal(result.verification.status, "passed");
  assert.ok(f.state.progress.some(item => /已保存/.test(item.message)));
});

test("an unrelated saved file invalidates an earlier read without stopping the task", async () => {
  const f = fixture();
  await f.run((turn, request) => {
    if (turn === 1) return call(turn, "read_file", { path: "README.md" });
    if (turn === 2) return call(turn, "apply_changes", { head: f.state.head, reason: "Save another file", changes: [change("NOTES.md", "A separate saved step.\n")] });
    if (turn === 3) return call(turn, "apply_changes", { head: f.state.head, reason: "Update README", changes: [change("README.md", initialReadme + "Updated.\n")] });
    if (turn === 4) {
      recovery(request, "file_read_required", f.state.head, ["README.md"]);
      assert.equal(f.state.writes, 1); assert.equal(f.state.writeAttempts, 1); assert.equal(f.state.checkpoints.length, 1);
      assert.equal(f.files.get("README.md"), initialReadme);
      return call(turn, "read_file", { path: "README.md" });
    }
    if (turn === 5) return call(turn, "apply_changes", { head: f.state.head, reason: "Update refreshed README", changes: [change("README.md", initialReadme + "Updated.\n")] });
    return finish();
  });
  assert.equal(f.state.requests.length, 6); assert.equal(f.state.writes, 2);
  assert.equal(f.state.reads.filter(path => path === "README.md").length, 2);
  assert.equal(f.files.get("NOTES.md"), "A separate saved step.\n");
});

test("a stale head is rejected before writing and a re-read preserves external edits", async () => {
  const f = fixture(), stale = f.state.head;
  const external = initialReadme + "An external user edit.\n";
  await f.run((turn, request) => {
    if (turn === 1) return call(turn, "read_file", { path: "README.md" });
    if (turn === 2) {
      f.externalEdit("README.md", external);
      return call(turn, "apply_changes", { head: stale, reason: "Outdated proposal", changes: [change("README.md", "Would discard the external edit.\n")] });
    }
    if (turn === 3) {
      recovery(request, "stale_head", f.state.head, ["README.md"]);
      assert.equal(f.state.writes, 0); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.checkpoints.length, 0);
      assert.equal(f.files.get("README.md"), external);
      return call(turn, "read_file", { path: "README.md" });
    }
    if (turn === 4) {
      assert.ok(toolResults(request).some(item => item.path === "README.md" && item.content === external));
      return call(turn, "apply_changes", { head: f.state.head, reason: "Preserve the user edit", changes: [change("README.md", external + "Agent update.\n")] });
    }
    return finish();
  });
  assert.equal(f.files.get("README.md"), external + "Agent update.\n"); assert.equal(f.state.writes, 1);
  assert.equal(f.state.requests.length, 5);
});

test("repeated unmet read guards allow at most three recoveries and never write", async () => {
  const f = fixture();
  await assert.rejects(f.run((turn, request) => {
    if (turn > 1) recovery(request, "file_read_required", f.state.head, ["README.md"]);
    return call(turn, "apply_changes", { head: f.state.head, reason: "Still not read", changes: [change("README.md", "Unreviewed replacement.\n")] });
  }), error => /读取|冲突|恢复|重试/.test(publicError(error)));
  assert.equal(f.state.requests.length, 4, "The fourth rejected write must stop without another model call");
  assert.equal(f.state.writes, 0); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.checkpoints.length, 0);
  assert.equal(f.files.get("README.md"), initialReadme);
});

test("ignoring recovery feedback cannot turn an unfinished write into a successful task", async t => {
  for (const readAgain of [false, true]) await t.test(readAgain ? "read without a corrected write" : "immediate final output", async () => {
    const f = fixture();
    await assert.rejects(f.run((turn, request) => {
      if (turn === 1) return call(turn, "apply_changes", { head: f.state.head, reason: "Unread change", changes: [change("README.md", "Replacement.\n")] });
      if (turn === 2) {
        recovery(request, "file_read_required", f.state.head, ["README.md"]);
        if (readAgain) return call(turn, "read_file", { path: "README.md" });
      }
      return finish();
    }), error => /读取|冲突|恢复|完成|保存/.test(publicError(error)));
    assert.equal(f.state.requests.length, readAgain ? 3 : 2);
    assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
    assert.equal(f.files.get("README.md"), initialReadme);
  });
});

test("saving an unrelated file does not clear an unresolved rejected README edit", async () => {
  const f = fixture();
  await assert.rejects(f.run((turn, request) => {
    if (turn === 1) return call(turn, "apply_changes", { head: f.state.head, reason: "Unread README change", changes: [change("README.md", "Rejected replacement.\n")] });
    if (turn === 2) {
      recovery(request, "file_read_required", f.state.head, ["README.md"]);
      return call(turn, "apply_changes", { head: f.state.head, reason: "Save an unrelated step", changes: [change("NOTES.md", "This unrelated step was saved.\n")] });
    }
    return finish();
  }), error => /读取|冲突|恢复|完成|保存/.test(publicError(error)));
  assert.equal(f.state.requests.length, 3); assert.equal(f.state.writes, 1);
  assert.equal(f.state.checkpoints.length, 1, "The saved unrelated step should still be retained");
  assert.equal(f.files.get("README.md"), initialReadme); assert.equal(f.files.get("NOTES.md"), "This unrelated step was saved.\n");
});

test("saving only one target of a rejected batch leaves the other target unfinished", async () => {
  const f = fixture();
  await assert.rejects(f.run((turn, request) => {
    if (turn === 1) return call(turn, "apply_changes", { head: f.state.head, reason: "Unread mixed batch", changes: [
      change("README.md", "Rejected replacement.\n"), change("REPORT.md", "The requested report.\n"),
    ] });
    if (turn === 2) {
      recovery(request, "file_read_required", f.state.head, ["README.md"]);
      assert.equal(f.files.has("REPORT.md"), false, "A rejected batch must not partially create files");
      return call(turn, "read_file", { path: "README.md" });
    }
    if (turn === 3) return call(turn, "apply_changes", { head: f.state.head, reason: "Fix only README", changes: [change("README.md", initialReadme + "Updated.\n")] });
    return finish();
  }), error => /读取|冲突|恢复|完成|保存/.test(publicError(error)));
  assert.equal(f.state.requests.length, 4); assert.equal(f.state.writes, 1); assert.equal(f.state.checkpoints.length, 1);
  assert.equal(f.files.get("README.md"), initialReadme + "Updated.\n"); assert.equal(f.files.has("REPORT.md"), false);
});

test("protected and invalid paths remain fatal without a recovery round", async t => {
  for (const path of [".env.local", "../README.md", ".scenarioforge/skills/forbidden.md"]) await t.test(path, async () => {
    const f = fixture();
    await assert.rejects(f.run(turn => call(turn, "apply_changes", { head: f.state.head, reason: "Forbidden target", changes: [change(path, "Must not write")] })),
      error => /路径|文件|Agent|技能/.test(publicError(error)));
    assert.equal(f.state.requests.length, 1); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.writes, 0);
    assert.equal(f.state.checkpoints.length, 0); assert.ok(!f.files.has(path));
  });
});

test("unread selected skills and stopped execution remain fatal", async t => {
  await t.test("selected skill prerequisite", async () => {
    const skill = snapshotSkill({ id: "required-skill", packageId: "required-package", filename: "PLAN.md", content: "Read before editing.", version: 1,
      package: { title: "Required skill", researchPlan: null } });
    const f = fixture({ skills: [skill] });
    await assert.rejects(f.run(turn => call(turn, "apply_changes", { head: f.state.head, reason: "Skip required skill", changes: [change("NEW.md", "No read")] })), /技能/);
    assert.equal(f.state.requests.length, 1); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.checkpoints.length, 0);
  });
  await t.test("stopped lease", async () => {
    const f = fixture();
    await assert.rejects(f.run(turn => {
      f.state.stopped = true;
      return call(turn, "apply_changes", { head: f.state.head, reason: "Stopped task", changes: [change("NEW.md", "Must not write")] });
    }), /停止|租约/);
    assert.equal(f.state.requests.length, 1); assert.equal(f.state.writeAttempts, 0); assert.equal(f.state.checkpoints.length, 0);
  });
});

test("backend errors remain fatal even when their HTTP status resembles a file conflict", async t => {
  for (const status of [403, 409, 502]) await t.test(`HTTP ${status}`, async () => {
    const message = `Safe backend failure ${status}`;
    const f = fixture({ writeError: new ApiError(status, message) });
    await assert.rejects(f.run(turn => call(turn, "apply_changes", { head: f.state.head, reason: "Backend failure", changes: [change("NEW.md", "Must not write")] })),
      error => publicError(error) === message);
    assert.equal(f.state.requests.length, 1, "A backend failure must not trigger a speculative retry");
    assert.equal(f.state.writeAttempts, 1); assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
    assert.ok(!f.files.has("NEW.md"));
  });
});
