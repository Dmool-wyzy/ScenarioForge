import "server-only";
import { db } from "../db";
import { saveSource, sourceKeyForUrl, type SourceInput } from "./sources";
import { completedSearchQuestions } from "../search/progress";
import { readResearchPlan } from "../research-plan";

export async function backfillPackage(packageId: string, dryRun = false) {
  const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, include: { files: true, clarifications: true, evidence: true, events: { orderBy: { sequence: "asc" } } } });
  const uploaded = JSON.parse(pkg.uploadedFiles) as { id?: string; filename: string; extractedText: string }[];
  const plan = readResearchPlan(pkg.researchPlan);
  const stats = { packageId, questions: plan?.researchQuestions.length ?? 0, uploads: uploaded.length, files: pkg.files.length, answers: pkg.clarifications.filter(row => row.answer).length, evidenceCards: pkg.evidence.length };
  if (dryRun) return stats;
  await db.$transaction(async tx => {
    const existingKeys = new Set((await tx.source.findMany({ where: { packageId }, select: { sourceKey: true } })).map(row => row.sourceKey));
    const historical = (input: SourceInput) => existingKeys.has(input.sourceKey) ? Promise.resolve(null) : saveSource(tx, packageId, input);
    const completed = completedSearchQuestions(pkg.events);
    for (const [ordinal, detail] of (plan?.questionDetails ?? []).entries()) {
      const row = await tx.researchQuestion.upsert({ where: { packageId_ordinal: { packageId, ordinal } }, update: {}, create: { packageId, ordinal, question: detail.question, searchQueries: JSON.stringify(detail.searchQueries), priority: detail.priority,
        status: completed.has(detail.question) ? "completed" : "pending" } });
      await tx.evidence.updateMany({ where: { packageId, question: detail.question, questionId: null }, data: { questionId: row.id } });
    }
    await historical({ sourceType: "upload", sourceKey: "goal", title: "用户目标与约束", content: `${pkg.goal}\n\n${pkg.constraints ?? "{}"}`, metadata: { origin: "user_goal", trust: "user_provided" } });
    for (const [index, file] of uploaded.entries()) await historical({ sourceType: "upload", sourceKey: `upload:${file.id ?? index}`, title: file.filename, content: file.extractedText, metadata: { filename: file.filename, uploadId: file.id ?? `upload-${index}`, trust: "user_provided" } });
    for (const card of pkg.evidence) {
      for (const source of JSON.parse(card.sources) as { title: string; url: string; snippet: string; accessedAt: string }[]) {
        await historical({ sourceType: "web", sourceKey: sourceKeyForUrl(source.url), title: source.title, url: source.url, content: source.snippet, fetchedAt: new Date(source.accessedAt),
          metadata: { questionId: card.questionId, question: card.question, contentKind: "search_snippet", trust: source.snippet.includes("[MOCK SEARCH RESULT]") ? "mock" : "external" } });
      }
    }
    for (const event of pkg.events) {
      if (event.type !== "evidence_found" || !event.payload) continue;
      const payload = JSON.parse(event.payload);
      if (payload.kind !== "search_results") continue;
      for (const source of payload.sources) await historical({ sourceType: "web", sourceKey: sourceKeyForUrl(source.url), title: source.title, url: source.url, content: source.snippet, fetchedAt: new Date(payload.fetchedAt),
        metadata: { question: payload.question, contentKind: "search_snippet", provider: payload.provider, trust: payload.provider === "mock" ? "mock" : "external" } });
    }
    for (const file of pkg.files) await historical({ sourceType: "workspace", sourceKey: `workspace:${file.filename}`, title: file.filename, content: file.content,
      metadata: { filename: file.filename, fileVersion: file.version, updatedBy: file.updatedBy, trust: file.updatedBy === "user" ? "user_provided" : "ai_analysis", origin: /DECISION/.test(file.filename) ? "agent_decision" : "workspace" } });
    for (const row of pkg.clarifications) if (row.answer) await historical({ sourceType: "clarification", sourceKey: `clarification:${row.id}`, title: row.question,
      content: `问题：${row.question}\n回答：${row.answer}`, metadata: { clarificationId: row.id, answeredBy: row.answeredBy, trust: row.answeredBy === "user" ? "user_confirmed" : "unconfirmed_assumption" } });
  }, { timeout: 30000 });
  return stats;
}
