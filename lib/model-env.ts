import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const modelKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_MODE", "SCENARIOFORGE_MODEL", "MODEL_TIMEOUT_SECONDS", "MODEL_REASONING_EFFORT", "MODEL_MAX_OUTPUT_TOKENS"];

export function projectModelEnv(): Record<string, string> {
  // Isolated tests can explicitly select another file or use an empty path.
  const file = process.env.SCENARIOFORGE_ENV_FILE ?? ".env.local";
  if (!file) return {};
  try {
    const values = parseEnv(readFileSync(resolve(file), "utf8"));
    return Object.fromEntries(modelKeys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]!]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.SCENARIOFORGE_ENV_FILE) return {};
    throw new Error("无法读取项目模型配置文件，请检查 SCENARIOFORGE_ENV_FILE 或 .env.local。");
  }
}
