import { packageResearchConfig } from "@/lib/model-settings";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/errors";
import { createResearch, getContext, getResearch, saveEvidence, savePlan, updateFilePlan } from "@/lib/research";
import { beginSearch, searchQuestion } from "@/lib/search/service";
import { readJson } from "@/lib/validation";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/files";
import { askQuestions, getAnswers, answerQuestion } from "@/lib/clarifications";
import { ragEnabled } from "@/lib/rag/config";
import { knowledgeStatus } from "@/lib/rag/knowledge";
import { searchEvidence, getEvidence } from "@/lib/rag/retrieval";
import { prepareFileContext } from "@/lib/rag/context";
import { queueResearch, startTaskScheduler } from "@/lib/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const expected = process.env.SCENARIOFORGE_INTERNAL_TOKEN;
    if (!expected || expected.length < 32) throw new ApiError(503, "内部服务凭据尚未配置。");
    const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, "内部服务认证失败。");
    const { id } = await context.params;
    const body = z.object({ operation: z.string(), data: z.unknown().optional() }).parse(await readJson(request));
    if (body.operation === "create" && id === "new") {
      const pkg = await createResearch(body.data);
      await queueResearch(pkg.id, "请创建研究计划，收集证据并生成工作区。");
      startTaskScheduler();
      return Response.json(pkg);
    }
    await getResearch(id);
    if (body.operation === "model_config") {
      const config = await packageResearchConfig(id);
      return Response.json({ OPENAI_API_KEY: config.OPENAI_API_KEY, OPENAI_BASE_URL: config.OPENAI_BASE_URL, OPENAI_API_MODE: config.OPENAI_API_MODE, SCENARIOFORGE_MODEL: config.SCENARIOFORGE_MODEL, MODEL_TIMEOUT_SECONDS: config.MODEL_TIMEOUT_SECONDS, PROJECT_MODEL_CONFIG: config.PROJECT_MODEL_CONFIG ?? false, MODEL_VALIDATED_ADDRESS: config.MODEL_VALIDATED_ADDRESS, AGENT_RUN_ID: config.AGENT_RUN_ID }, { headers: { "Cache-Control": "no-store" } });
    }
    switch (body.operation) {
      case "context": return Response.json({ ...await getContext(id), ragEnabled: ragEnabled() });
      case "rag_status": return Response.json(await knowledgeStatus(id));
      case "rag_search": return Response.json(await searchEvidence(id, body.data));
      case "rag_evidence": return Response.json(await getEvidence(id, z.string().parse(body.data)));
      case "rag_file_context": return Response.json(await prepareFileContext(id, z.string().parse(body.data)));
      case "answer_user": {
        const data = z.object({ clarificationId: z.string().max(150), answer: z.union([z.string().max(5000), z.array(z.string().max(500)).max(10)]) }).parse(body.data);
        const result = await answerQuestion(id, data.clarificationId, data.answer);
        startTaskScheduler(); return Response.json(result);
      }
      case "plan": return Response.json(await savePlan(id, body.data));
      case "file_plan": return Response.json(await updateFilePlan(id, body.data));
      case "evidence": return Response.json(await saveEvidence(id, body.data));
      case "begin_search": return Response.json(await beginSearch(id, body.data));
      case "search": return Response.json(await searchQuestion(id, body.data));
      case "search_evidence": {
        const data = z.object({ question: z.string().min(1).max(1000), cards: z.unknown() }).parse(body.data);
        return Response.json(await saveEvidence(id, data.cards, data.question));
      }
      case "read_file": return Response.json(await readWorkspaceFile(id, z.string().parse(body.data)));
      case "write_file": return Response.json(await writeWorkspaceFile(id, body.data));
      case "wait_edit": {
        await db.researchPackage.update({ where: { id }, data: { status: "waiting_for_edit" } });
        return Response.json({ status: "waiting_for_edit" });
      }
      case "ask": return Response.json(await askQuestions(id, body.data));
      case "answers": {
        const data = z.object({ clarificationId: z.string().max(150), timeout: z.boolean().default(false) }).parse(body.data);
        return Response.json(await getAnswers(id, data.clarificationId, data.timeout));
      }
      default: throw new ApiError(400, "不支持的内部操作。");
    }
  } catch (error) { return errorResponse(error); }
}
