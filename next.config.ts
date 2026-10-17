import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.SCENARIOFORGE_TEST_DIST === "true" ? ".tmp/next-agent-build" : ".next",
  poweredByHeader: false,
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
