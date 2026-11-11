import "server-only";
import { z } from "zod";
import { projectModelEnv } from "./model-env";
import { isOfficialDeepSeek, MAX_MODEL_OUTPUT_TOKENS, MIN_MODEL_OUTPUT_TOKENS, REASONING_EFFORTS } from "./model-policy";

const databaseSchema = z.object({
  DATABASE_URL: z.string().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "mysql:" && !!url.hostname && url.pathname.length > 1;
    } catch { return false; }
  }, "DATABASE_URL 必须是包含主机与数据库名的 MySQL 连接地址"),
});

const researchSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  OPENAI_API_MODE: z.enum(["responses", "chat_completions"]).default("responses"),
  SCENARIOFORGE_MODEL: z.string().min(1),
  MODEL_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(300).default(120),
  MODEL_REASONING_EFFORT: z.preprocess(value => value === "" ? undefined : value, z.enum(REASONING_EFFORTS).optional()),
  MODEL_MAX_OUTPUT_TOKENS: z.preprocess(value => value === "" ? undefined : value, z.coerce.number().int().min(MIN_MODEL_OUTPUT_TOKENS).max(MAX_MODEL_OUTPUT_TOKENS).optional()),
  SCENARIOFORGE_MCP_URL: z.url().default("http://localhost:8000/mcp"),
  SCENARIOFORGE_INTERNAL_TOKEN: z.string().min(32),
  SCENARIOFORGE_BACKEND_URL: z.url().default("http://localhost:3000"),
}).refine(settings => settings.MODEL_REASONING_EFFORT !== "medium" || !isOfficialDeepSeek(settings.OPENAI_BASE_URL), {
  message: "DeepSeek 未提供独立的中等思考档位。", path: ["MODEL_REASONING_EFFORT"],
});

function parseConfig<T extends z.ZodType>(schema: T, values = process.env): z.output<T> {
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`环境变量缺失或无效：${fields.join("、")}。请检查 .env.local。`);
  }
  return parsed.data;
}

export function getDatabaseConfig() { return parseConfig(databaseSchema); }
export function getResearchConfig(overrides: Record<string, string> = {}) { return parseConfig(researchSchema, { ...process.env, ...projectModelEnv(), ...overrides }); }
