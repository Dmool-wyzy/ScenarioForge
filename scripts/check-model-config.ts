import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { test } from "node:test";
import { Agent, Runner } from "@openai/agents";
import { createModelProvider } from "../lib/openai";
import { getResearchConfig } from "../lib/env";
import { logError } from "../lib/errors";

test("project model credentials reach HTTP authorization instead of the inherited system key", async () => {
  const original = { ...process.env };
  mkdirSync(resolve(".tmp"), { recursive: true });
  const directory = mkdtempSync(resolve(".tmp/model-config-"));
  const file = join(directory, ".env.local");
  const requests: { authorization?: string; model: string }[] = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, model: JSON.parse(body).model });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "resp_fixture", object: "response", created_at: 0, status: "completed", model: "project-model", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(file, `OPENAI_API_KEY=project-only-key\nOPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1\nOPENAI_API_MODE=responses\nSCENARIOFORGE_MODEL=project-model\nMODEL_REASONING_EFFORT=low\nMODEL_MAX_OUTPUT_TOKENS=1234\n`);
  Object.assign(process.env, { SCENARIOFORGE_ENV_FILE: file, OPENAI_API_KEY: "system-only-key", OPENAI_BASE_URL: "http://system.invalid/v1", SCENARIOFORGE_MODEL: "system-model", SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3) });
  const provider = createModelProvider();
  try {
    assert.equal(getResearchConfig().MODEL_REASONING_EFFORT, "low");
    assert.equal(getResearchConfig().MODEL_MAX_OUTPUT_TOKENS, 1234);
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    await runner.run(new Agent({ name: "config fixture", model: getResearchConfig().SCENARIOFORGE_MODEL }), "test");
    assert.deepEqual(requests, [{ authorization: "Bearer project-only-key", model: "project-model" }]);
    const messages: unknown[][] = [];
    const originalError = console.error;
    try {
      console.error = (...args) => { messages.push(args); };
      logError(new Error("project-only-key system-only-key"));
      assert.equal(JSON.stringify(messages).includes("project-only-key"), false);
      assert.equal(JSON.stringify(messages).includes("system-only-key"), false);
    } finally { console.error = originalError; }
    writeFileSync(file, "OPENAI_API_KEY=\n");
    assert.throws(getResearchConfig, /OPENAI_API_KEY/);
    process.env.SCENARIOFORGE_ENV_FILE = "";
    assert.equal(getResearchConfig().OPENAI_API_KEY, "system-only-key");
  } finally {
    await provider.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    process.env = original;
    assert.ok(directory.startsWith(resolve(".tmp") + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
