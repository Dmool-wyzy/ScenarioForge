import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", ".tmp/**", "next-env.d.ts", ".npm-cache/**", ".pip-cache/**", ".uv-cache/**", "mcp-server/.venv/**", "test-results/**", "playwright-report/**"]),
]);
