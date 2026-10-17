import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { Agent, Runner } from "@openai/agents";
import OpenAI from "openai";
import { createModelProvider } from "../lib/openai";

test("model connections use the configured budget beyond native fetch's 10 seconds without retrying", { timeout: 25_000 }, async () => {
  const originalEnv = { ...process.env };
  const sockets = new Set<net.Socket>();
  let connections = 0;
  // Hold the TLS handshake open past native fetch's connection timeout, then
  // close it. This needs no certificates or external model requests.
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), 11_500);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    SCENARIOFORGE_ENV_FILE: "",
    OPENAI_API_KEY: "fixture-local-key", OPENAI_BASE_URL: `https://127.0.0.1:${address.port}/v1`,
    OPENAI_API_MODE: "responses", SCENARIOFORGE_MODEL: "fixture-model", MODEL_TIMEOUT_SECONDS: "20",
    SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3),
  });
  const provider = createModelProvider();
  const started = Date.now();
  try {
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    const agent = new Agent({ name: "transport fixture", model: "fixture-model", modelSettings: { retry: { maxRetries: 0 } } });
    await assert.rejects(runner.run(agent, "test"), (error: unknown) => {
      assert.ok(error instanceof OpenAI.APIConnectionError);
      assert.equal(error instanceof OpenAI.APIConnectionTimeoutError, false, "connection was cut off before the configured budget");
      return true;
    });
    assert.ok(Date.now() - started >= 11_000);
    assert.equal(connections, 1, "a failed model request must not be retried");
  } finally {
    await provider.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    process.env = originalEnv;
  }
});
