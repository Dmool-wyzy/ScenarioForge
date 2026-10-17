import "server-only";
import { z } from "zod";
import { db } from "../db";
import { emitEvent } from "../events";
import { ApiError } from "../errors";
import { getSearchProvider, searchProviderName } from "./index";
import { maxSearchResults } from "./shared";
import { SearchProviderError } from "./types";
import { getContext } from "../research";
import { ragEnabled } from "../rag/config";
import { saveSource, sourceKeyForUrl } from "../rag/sources";

const questionSchema = z.string().trim().min(1).max(1000);
export async function beginSearch(id: string, input: unknown) {
  const data = typeof input === "string" ? { question: questionSchema.parse(input), question_index: undefined }
    : z.object({ question_index: z.number().int().min(0).max(5).optional(), question_id: z.string().max(150).optional() }).refine(value => value.question_index !== undefined || !!value.question_id).parse(input);
  const context = await getContext(id);
  const questions: string[] = context.researchPlan?.researchQuestions ?? [];
  const selected = "question_id" in data && data.question_id ? context.researchPlan?.questionDetails.find(detail => detail.id === data.question_id) : null;
  const question = selected?.question ?? (data.question_index === undefined ? ("question" in data ? data.question : undefined) : questions[data.question_index]);
  if (("question_id" in data && data.question_id && (!selected || (data.question_index !== undefined && questions[data.question_index] !== selected.question))) || !question || !questions.includes(question)) return {
    status: "question_required", questions: questions.map((question, question_index) => ({ question_index, question })),
    instruction: "请使用计划中的 question_index 调用检索，不要改写研究问题。此调用未扣除搜索额度。",
  };
  // Reuse successful work before checking the budget, including exhausted legacy
  // packages. Never charge for a duplicate or ask the model to research it again.
  if (context.searchedQuestions.includes(question.trim())) return {
    status: "already_researched", question, evidence: context.evidence.filter((card) => card.question === question),
    instruction: "该研究问题已检索并保存证据，无需重复搜索。所有计划问题完成后请调用 generate_workspace。",
  };
  try {
    const provider = getSearchProvider();
    const maxResults = maxSearchResults(provider.name);
    const updated = await db.researchPackage.updateMany({ where: { id, searchCount: { lt: 12 } }, data: { searchCount: { increment: 1 } } });
    if (!updated.count) throw new ApiError(429, "本研究包已达到 12 次搜索工具调用上限。请复用已有证据，完成计划内尚未生成的文件。");
    const saved = await db.researchQuestion.findFirst({ where: { packageId: id, question } });
    if (saved) await db.researchQuestion.update({ where: { id: saved.id }, data: { status: "searching", attemptCount: { increment: 1 } } });
    return { status: "ready", question, questionId: saved?.id, maxResults };
  } catch (error) {
    await reportSearchFailure(id, question, question, error);
    throw error;
  }
}

async function reportSearchFailure(id: string, question: string, query: string, error: unknown) {
  let provider: string = "invalid";
  try { provider = searchProviderName(); } catch { /* invalid configuration */ }
  const invalidConfig = error instanceof Error && error.message.startsWith("SEARCH_PROVIDER 无效");
  const failure = error instanceof SearchProviderError ? error : { provider, code: invalidConfig ? "missing_config" : "upstream_error", message: invalidConfig ? "搜索配置无效，请检查 SEARCH_PROVIDER 及相关环境变量。" : "搜索服务暂时不可用，请稍后重试或切换搜索 Provider。" };
  await db.researchQuestion.updateMany({ where: { packageId: id, question }, data: { status: "failed", lastError: failure.code } });
  await emitEvent(id, "search_failed", `搜索失败：${failure.message}`, { question, query, provider: failure.provider, code: failure.code, message: failure.message });
}

export async function searchQuestion(id: string, input: unknown) {
  const data = z.object({ question: questionSchema, query: questionSchema, maxResults: z.number().int().min(1).max(20).optional() }).parse(input);
  try {
    const provider = getSearchProvider();
    const maxResults = Math.min(data.maxResults ?? maxSearchResults(provider.name), maxSearchResults(provider.name));
    await emitEvent(id, "search_started", `正在检索 [${provider.name}]：${data.query}`, { question: data.question, provider: provider.name, query: data.query });
    const result = await provider.search({ query: data.query, maxResults });
    if (ragEnabled()) await db.$transaction(async tx => {
      const question = await tx.researchQuestion.findFirst({ where: { packageId: id, question: data.question } });
      for (const source of result.results) await saveSource(tx, id, { sourceType: "web", sourceKey: sourceKeyForUrl(source.url), title: source.title, url: source.url, content: source.snippet, fetchedAt: new Date(result.fetchedAt),
        metadata: { questionId: question?.id, question: data.question, provider: result.provider, contentKind: "search_snippet", trust: result.provider === "mock" ? "mock" : "external" } });
    });
    await emitEvent(id, "evidence_found", `[${result.provider}] 搜索完成：${result.results.length} 条结果 · ${result.query}`, {
      kind: "search_results", question: data.question, provider: result.provider, query: result.query, fetchedAt: result.fetchedAt, resultCount: result.results.length, sources: result.results,
    });
    return result;
  } catch (error) {
    await reportSearchFailure(id, data.question, data.query, error);
    throw error;
  }
}
