import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL: `http://localhost:${process.env.AGENT_E2E_PORT ?? "3000"}`, channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge", headless: true, screenshot: "only-on-failure" },
});
