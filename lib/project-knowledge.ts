import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { ApiError } from "./errors";
import { sourceSchema } from "./search/sources";

const shareInput = z.object({ packageId: z.string().min(1).max(100), evidenceId: z.string().min(1).max(100) });

function terms(text: string) {
  const parts = text.toLocaleLowerCase().match(/[a-z0-9_-]+|[\u3400-\u9fff]+/g) ?? [];
  return new Set(parts.flatMap(part => {
    if (!/^[\u3400-\u9fff]+$/.test(part) || part.length < 2) return [part];
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2));
  }));
}

export function scoreProjectKnowledge(query: string, item: { title: string; question: string; claim: string; sources: string }) {
  const queryText = query.trim().toLocaleLowerCase();
  if (!queryText) return 0;
  const queryTerms = terms(queryText);
  let sources = "";
  try { sources = (JSON.parse(item.sources) as { title?: string; snippet?: string }[]).map(source => `${source.title ?? ""} ${source.snippet ?? ""}`).join(" "); } catch { /* Stored source JSON is validated when records are created. */ }
  const scoreField = (value: string, weight: number) => [...queryTerms].reduce((score, term) => score + (value.toLocaleLowerCase().includes(term) ? weight : 0), 0);
  return (item.title.toLocaleLowerCase().includes(queryText) ? 8 : 0) + scoreField(item.title, 5) + scoreField(item.question, 3) + scoreField(item.claim, 2) + scoreField(sources, 1);
}

export async function listProjectKnowledge(projectId: string, query: string, includeArchived = false) {
  const where = { projectId, ...(includeArchived ? {} : { archivedAt: null }) };
  const [rows, total] = await Promise.all([
    db.projectKnowledgeItem.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 }),
    db.projectKnowledgeItem.count({ where }),
  ]);
  const ranked = rows.map(item => ({ item, score: scoreProjectKnowledge(query, item) }))
    .filter(row => !query.trim() || row.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt.getTime() - a.item.createdAt.getTime())
    .slice(0, 20)
    .map(({ item, score }) => ({ ...item, sources: JSON.parse(item.sources), matchScore: score }));
  return { total, results: ranked };
}

export async function shareEvidenceWithProject(projectId: string, userId: string, input: unknown) {
  const { packageId, evidenceId } = shareInput.parse(input);
  const pkg = await db.researchPackage.findFirst({ where: { id: packageId, projectId }, select: { title: true } });
  if (!pkg) throw new ApiError(404, "研究包不属于此项目，或已不存在。");
  const evidence = await db.evidence.findFirst({ where: { id: evidenceId, packageId } });
  if (!evidence) throw new ApiError(404, "未找到该研究证据。");
  const sources = z.array(sourceSchema).min(1).max(10).parse(JSON.parse(evidence.sources));
  if (sources.some(source => source.snippet.includes("[MOCK SEARCH RESULT]"))) throw new ApiError(409, "Mock 模拟搜索证据不能加入团队共享知识库。");
  const storedSources = sources.slice(0, 5).map(source => ({ ...source, snippet: source.snippet.slice(0, 1200) }));
  const data = { projectId, title: evidence.claim.trim().slice(0, 200) || evidence.code, question: evidence.question, claim: evidence.claim,
    sources: JSON.stringify(storedSources), confidence: evidence.confidence, status: evidence.status, originPackageId: packageId,
    originPackageTitle: pkg.title.slice(0, 200), originEvidenceId: evidence.id, originEvidenceCode: evidence.code, createdBy: userId };
  const unique = { projectId_originPackageId_originEvidenceId: { projectId, originPackageId: packageId, originEvidenceId: evidence.id } };
  try {
    const item = await db.projectKnowledgeItem.create({ data });
    return { item: { ...item, sources: storedSources }, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const item = await db.projectKnowledgeItem.findUniqueOrThrow({ where: unique });
    return { item: { ...item, sources: JSON.parse(item.sources) }, created: false };
  }
}
