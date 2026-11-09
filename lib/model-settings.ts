import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { ApiError } from "./errors";
import { getResearchConfig } from "./env";
import { modelAddress, modelBaseUrl } from "./model-endpoint";
import { requireProjectAccess } from "./auth";

export const modelSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2000).transform(modelBaseUrl),
  model: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/),
  apiMode: z.enum(["responses", "chat_completions"]),
  timeoutSeconds: z.number().int().min(10).max(300).default(120),
  deepseekSearchEnabled: z.boolean().default(false),
  apiKey: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/).optional(),
}).refine(settings => !settings.deepseekSearchEnabled || new URL(settings.baseUrl).hostname === "api.deepseek.com", {
  message: "DeepSeek Search 仅支持 api.deepseek.com。",
  path: ["deepseekSearchEnabled"],
});
export type ModelSettings = Omit<z.infer<typeof modelSettingsSchema>, "apiKey"> & { apiKey: string };
export type ResearchConfig = ReturnType<typeof getResearchConfig> & { PROJECT_MODEL_CONFIG?: boolean; MODEL_VALIDATED_ADDRESS?: string; DEEPSEEK_SEARCH_ENABLED?: boolean; AGENT_RUN_ID?: string | null };

export function modelProviderData(settings: Pick<ModelSettings, "baseUrl" | "apiMode">) {
  // DeepSeek thinking mode rejects forced tool selection and requires reasoning history.
  return settings.apiMode === "chat_completions" && new URL(settings.baseUrl).hostname === "api.deepseek.com"
    ? { thinking: { type: "disabled" as const } }
    : {};
}

function encryptionKey() {
  const value = process.env.SCENARIOFORGE_SETTINGS_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new ApiError(503, "模型配置的安全存储尚未就绪，请联系管理员。");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new ApiError(503, "模型配置的安全存储尚未就绪，请联系管理员。");
  return key;
}

export function encryptModelSettings(projectId: string, settings: ModelSettings) {
  return encryptSettings(projectId, settings);
}

function encryptSettings(scope: string, settings: ModelSettings) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptModelSettings(projectId: string, value: string): ModelSettings {
  return decryptSettings(projectId, value);
}

function decryptSettings(scope: string, value: string): ModelSettings {
  const key = encryptionKey();
  try {
    const [version, iv, tag, data] = value.split(".");
    if (version !== "v1") throw new Error("Unsupported configuration version");
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    const decoded = JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, "base64")), cipher.final()]).toString("utf8"));
    const settings = modelSettingsSchema.parse(decoded);
    if (!settings.apiKey) throw new Error("Missing key");
    return { ...settings, apiKey: settings.apiKey };
  } catch { throw new ApiError(503, "无法读取已保存的模型配置，请联系管理员检查加密配置。"); }
}

export async function storedModelSettings(projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { modelConfigEncrypted: true } });
  if (!project) throw new ApiError(404, "未找到项目。");
  return project.modelConfigEncrypted ? decryptModelSettings(projectId, project.modelConfigEncrypted) : null;
}

export function settingsMetadata(settings: ModelSettings | null) {
  if (!settings) return null;
  const { baseUrl, model, apiMode, timeoutSeconds, deepseekSearchEnabled } = settings;
  return { baseUrl, model, apiMode, timeoutSeconds, deepseekSearchEnabled, hasApiKey: true };
}

export async function modelSettingsAccess(request: Request, projectId: string, write = false) {
  const user = await requireProjectAccess(request, projectId);
  const member = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: user.id } } });
  const canEdit = member.role === "owner";
  if (write && !canEdit) throw new ApiError(403, "只有项目创建者可以修改或测试模型配置。");
  return { user, canEdit };
}

export async function prepareModelSettings(projectId: string, input: unknown) {
  const draft = modelSettingsSchema.parse(input);
  const previous = draft.apiKey ? null : await storedModelSettings(projectId);
  if (previous && previous.baseUrl !== draft.baseUrl) throw new ApiError(400, "更换 API 地址时，请重新填写对应服务的 API Key。");
  const apiKey = draft.apiKey || previous?.apiKey;
  if (!apiKey) throw new ApiError(400, "请填写 API Key。");
  const address = await modelAddress(draft.baseUrl);
  return { settings: { ...draft, apiKey }, address };
}

function personalAgentScope(projectId: string, userId: string) { return `${projectId}:${userId}`; }

export function encryptPersonalAgentSettings(projectId: string, userId: string, settings: ModelSettings) {
  return encryptSettings(personalAgentScope(projectId, userId), settings);
}

export function decryptPersonalAgentSettings(projectId: string, userId: string, value: string) {
  return decryptSettings(personalAgentScope(projectId, userId), value);
}

export function personalAgentSettingsMetadata(settings: ModelSettings | null) {
  if (!settings) return null;
  const { baseUrl, model, apiMode, timeoutSeconds } = settings;
  return { baseUrl, model, apiMode, timeoutSeconds, hasApiKey: true };
}

export async function storedPersonalAgentSettings(projectId: string, userId: string) {
  const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { personalAgentConfigEncrypted: true } });
  if (!member) throw new ApiError(404, "未找到项目成员记录。");
  return member.personalAgentConfigEncrypted ? decryptSettings(personalAgentScope(projectId, userId), member.personalAgentConfigEncrypted) : null;
}

export async function preparePersonalAgentSettings(projectId: string, userId: string, input: unknown) {
  const draft = modelSettingsSchema.parse(input);
  const previous = draft.apiKey ? null : await storedPersonalAgentSettings(projectId, userId);
  if (previous && previous.baseUrl !== draft.baseUrl) throw new ApiError(400, "更换 API 地址时，请重新填写对应服务的 API Key。");
  const apiKey = draft.apiKey || previous?.apiKey;
  if (!apiKey) throw new ApiError(400, "请填写个人 Agent API Key。");
  const settings = { ...draft, apiKey, deepseekSearchEnabled: false };
  const address = await modelAddress(settings.baseUrl);
  return { settings, address };
}

export async function personalAgentResearchConfig(projectId: string, userId: string) {
  const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { acceptsAgentTasks: true, personalAgentConfigEncrypted: true } });
  if (!member?.acceptsAgentTasks || !member.personalAgentConfigEncrypted) throw new ApiError(409, "该成员已关闭接收，或尚未配置个人 Agent。");
  const settings = decryptPersonalAgentSettings(projectId, userId, member.personalAgentConfigEncrypted);
  const address = await modelAddress(settings.baseUrl);
  return { ...getResearchConfig({
    OPENAI_API_KEY: settings.apiKey,
    OPENAI_BASE_URL: settings.baseUrl,
    OPENAI_API_MODE: settings.apiMode,
    SCENARIOFORGE_MODEL: settings.model,
    MODEL_TIMEOUT_SECONDS: String(settings.timeoutSeconds),
  }), PROJECT_MODEL_CONFIG: true, MODEL_VALIDATED_ADDRESS: address };
}

async function resolveResearchConfig(projectId?: string | null, encrypted?: string | null): Promise<ResearchConfig> {
  if (!projectId || !encrypted) return { ...getResearchConfig(), PROJECT_MODEL_CONFIG: false, DEEPSEEK_SEARCH_ENABLED: false };
  const settings = decryptModelSettings(projectId, encrypted);
  const address = await modelAddress(settings.baseUrl);
  return { ...getResearchConfig({
    OPENAI_API_KEY: settings.apiKey,
    OPENAI_BASE_URL: settings.baseUrl,
    OPENAI_API_MODE: settings.apiMode,
    SCENARIOFORGE_MODEL: settings.model,
    MODEL_TIMEOUT_SECONDS: String(settings.timeoutSeconds),
  }), PROJECT_MODEL_CONFIG: true, MODEL_VALIDATED_ADDRESS: address, DEEPSEEK_SEARCH_ENABLED: settings.deepseekSearchEnabled };
}

export async function projectResearchConfig(projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { modelConfigEncrypted: true } });
  if (!project) throw new ApiError(404, "未找到项目。");
  return resolveResearchConfig(projectId, project.modelConfigEncrypted);
}

export async function packageResearchConfig(packageId: string) {
  const pkg = await db.researchPackage.findUnique({ where: { id: packageId }, select: { projectId: true, modelConfigEncrypted: true, leaseOwner: true, taskState: true } });
  if (!pkg) throw new ApiError(404, "未找到研究包。");
  return { ...(await resolveResearchConfig(pkg.projectId, pkg.modelConfigEncrypted)), AGENT_RUN_ID: pkg.taskState === "running" ? pkg.leaseOwner : null };
}
