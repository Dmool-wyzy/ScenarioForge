import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFailureDiagnostic } from "../lib/workspace-agent/failure-diagnostic";

const secret = "sk-private-upstream-response-and-workspace-content";
type DiagnosticError = Error & { code?: unknown; status?: unknown; cause?: unknown };

test("workspace failure diagnostics keep safe error metadata and redact messages and paths", () => {
  const cause = new Error(`Provider body: ${secret}`) as DiagnosticError;
  cause.stack = `Error: ${secret}\n    at readFile (C:\\Users\\Alice\\ScenarioForge\\private\\local-runner.mjs:81:9)`;
  const error = new TypeError(`Request included ${secret}`, { cause }) as DiagnosticError;
  error.code = "E_RUNNER_FAILED";
  error.status = 502;
  error.stack = `TypeError: ${secret}\n    at executeWorkspace (D:\\private\\project\\lib\\workspace-agent\\jobs.ts:123:17)\n    at async processTicks (node:internal/process/task_queues:95:5)`;

  const diagnostic = workspaceFailureDiagnostic(error);

  assert.deepEqual(diagnostic.errorTypes, ["TypeError", "Error"]);
  assert.deepEqual(diagnostic.codes, ["E_RUNNER_FAILED"]);
  assert.deepEqual(diagnostic.statuses, [502]);
  assert.deepEqual(diagnostic.frames, [
    { file: "jobs.ts", line: 123, function: "executeWorkspace" },
    { file: "task_queues", line: 95, function: "processTicks" },
  ]);
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /private-upstream|Users|Alice|ScenarioForge|local-runner|jobs\.ts.*private|TypeError:|Provider body/);
  assert.doesNotMatch(serialized, new RegExp(secret));
});

test("workspace failure diagnostics reject unsafe code and out-of-range status", () => {
  const error = new Error("not retained") as DiagnosticError;
  error.code = "Bearer sk-private-value";
  error.status = 2000;
  error.stack = `Error: ${secret}\n    at handler (/srv/private/path/handler.ts:8:4)`;

  const diagnostic = workspaceFailureDiagnostic(error);

  assert.deepEqual(diagnostic.codes, []);
  assert.deepEqual(diagnostic.statuses, []);
  assert.deepEqual(diagnostic.frames, [{ file: "handler.ts", line: 8, function: "handler" }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Bearer|private-value|srv|private\/path/);
});

test("workspace failure diagnostics bound and de-duplicate cyclic cause chains", () => {
  const error = new Error("never retained") as DiagnosticError;
  error.code = "E_SAFE";
  error.status = 409;
  error.stack = "Error: cycle only";
  error.cause = error;

  const diagnostic = workspaceFailureDiagnostic(error);

  assert.deepEqual(diagnostic.errorTypes, ["Error"]);
  assert.deepEqual(diagnostic.codes, ["E_SAFE"]);
  assert.deepEqual(diagnostic.statuses, [409]);
  assert.deepEqual(diagnostic.frames, []);
});

test("workspace failure diagnostics safely represent non-Error throws", () => {
  const diagnostic = workspaceFailureDiagnostic({ message: secret, stack: `Error: ${secret}` });

  assert.deepEqual(diagnostic, { errorTypes: ["UnknownError"], codes: [], statuses: [], frames: [] });
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret));
});
