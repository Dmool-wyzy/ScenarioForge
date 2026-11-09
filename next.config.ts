import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.SCENARIOFORGE_TEST_DIST === "true" ? ".tmp/next-agent-build" : ".next",
  poweredByHeader: false,
  // Runtime environments and secrets must stay outside deployment traces.
  outputFileTracingExcludes: { "/*": ["./deploy/private/**/*", "./mcp-server/.venv/**/*"] },
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
