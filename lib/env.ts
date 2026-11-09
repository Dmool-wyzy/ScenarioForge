import "server-only";
import { z } from "zod";
import { projectModelEnv } from "./model-env";

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
  SCENARIOFORGE_MCP_URL: z.url().default("http://localhost:8000/mcp"),
  SCENARIOFORGE_INTERNAL_TOKEN: z.string().min(32),
  SCENARIOFORGE_BACKEND_URL: z.url().default("http://localhost:3000"),
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
