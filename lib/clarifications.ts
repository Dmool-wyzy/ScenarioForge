import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./errors";
import { appendEvent } from "./events";
import { ragEnabled } from "./rag/config";
import { saveSource } from "./rag/sources";

const questionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  type: z.enum(["text", "single_choice", "multi_choice"]).default("text"),
  options: z.array(z.string().min(1).max(500)).min(2).max(10).optional(),
  priority: z.enum(["blocking", "optional"]),
  why_needed: z.string().min(1).max(1500),
  default_assumption: z.string().max(2000).nullable().optional(),
}).refine((q) => q.type === "text" || !!q.options, { message: "选择题必须提供选项。" });

async function resumeIfReady(tx: Prisma.TransactionClient, packageId: string, reason: string) {
  const remaining = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
  if (remaining) return;
  const row = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
  if (!["waiting_for_user", "blocked"].includes(row.status)) return;
  const running = row.taskState === "running" && row.leaseUntil && row.leaseUntil > new Date();
  await tx.researchPackage.update({ where: { id: packageId }, data: { status: "researching", pendingMessage: [row.pendingMessage, reason].filter(Boolean).join("\n"), taskState: running ? "running" : "queued" } });
}

export async function askQuestions(packageId: string, input: unknown) {
  const questions = z.array(questionSchema).min(1).max(6).parse(input);
  return db.$transaction(async (tx) => {
    const p = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    const groups = await tx.clarification.findMany({ where: { packageId }, distinct: ["groupId"], select: { groupId: true } });
    if (groups.length >= 2 || p.questionCount + questions.length > 6) throw new ApiError(429, "每个研究包最多提问 2 轮、共 6 个问题。请基于已有信息继续或明确报告信息缺口。");
    const waiting = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
    if (waiting) throw new ApiError(409, "已有阻塞问题等待用户回答，请先读取答案。");
    const groupId = randomUUID();
    const rows = [];
    for (const [index, q] of questions.entries()) {
      rows.push(await tx.clarification.create({ data: { packageId, groupId, questionId: `${groupId}:${index + 1}`, question: q.question, type: q.type, options: q.options ? JSON.stringify(q.options) : null, priority: q.priority, whyNeeded: q.why_needed, defaultAssumption: q.default_assumption ?? null, expiresAt: new Date(Date.now() + 600_000) } }));
    }
    const blocking = questions.some((q) => q.priority === "blocking");
    await tx.researchPackage.update({ where: { id: packageId }, data: { questionCount: { increment: questions.length }, currentStage: 3, ...(blocking ? { status: "waiting_for_user" } : {}) } });
    await appendEvent(tx, packageId, "clarification_requested", blocking ? "需要你的回答，研究已暂停" : "有几项信息希望向你确认", { clarificationId: groupId, questionIds: rows.map((r) => r.id) });
    return { clarificationId: groupId, status: blocking ? "waiting_for_user" : "optional", questions: rows.map((r) => ({ ...r, options: r.options ? JSON.parse(r.options) : null })) };
  });
}

export async function answerQuestion(packageId: string, clarificationId: string, answer: string | string[], database: Pick<typeof db, "$transaction"> = db) {
  return database.$transaction(async (tx) => {
    const row = await tx.clarification.findFirst({ where: { id: clarificationId, packageId } });
    if (!row) throw new ApiError(404, "未找到此澄清问题。");
    if (row.status === "answered") throw new ApiError(409, "此问题已回答。");
    const options = row.options ? JSON.parse(row.options) as string[] : [];
    if (row.type === "text" && (typeof answer !== "string" || !answer.trim())) throw new ApiError(400, "请输入你的回答。");
    if (row.type === "single_choice" && (typeof answer !== "string" || !options.includes(answer))) throw new ApiError(400, "请选择一个有效选项。");
    if (row.type === "multi_choice" && (!Array.isArray(answer) || !answer.length || answer.some((value) => !options.includes(value)) || new Set(answer).size !== answer.length)) throw new ApiError(400, "请选择有效的选项。");
    const value = Array.isArray(answer) ? JSON.stringify(answer) : answer.trim();
    await tx.clarification.update({ where: { id: row.id }, data: { answer: value, answeredBy: "user", status: "answered", answeredAt: new Date() } });
    if (ragEnabled()) await saveSource(tx, packageId, { sourceType: "clarification", sourceKey: `clarification:${row.id}`, title: row.question, content: `问题：${row.question}\n回答：${value}`, metadata: { clarificationId: row.id, answeredBy: "user", trust: "user_confirmed" } });
    await tx.researchPackage.update({ where: { id: packageId }, data: { contextVersion: { increment: 1 } } });
    await appendEvent(tx, packageId, "clarification_answered", "已收到你的回答", { clarificationId, answer: value, answeredBy: "user" });
    await resumeIfReady(tx, packageId, "澄清问题已回答，请读取最新答案并继续研究。");
    // Answers to optional questions can arrive after completion; incorporate them in a new turn.
    const pkg = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    if (row.priority === "optional" && !["documents_plan_ready", "drafting_documents", "documents_ready", "documents_failed"].includes(pkg.status)) {
      const waiting = ["waiting_for_user", "blocked", "waiting_for_edit"].includes(pkg.status);
      const running = pkg.taskState === "running" && pkg.leaseUntil && pkg.leaseUntil > new Date();
      await tx.researchPackage.update({ where: { id: packageId }, data: { pendingMessage: [pkg.pendingMessage, "用户补充了可选问题的答案，请重新读取并更新工作区，保留用户修改。"].filter(Boolean).join("\n"), ...(!waiting ? { status: "researching", taskState: running ? "running" : "queued" } : {}) } });
    }
    return { status: "answered" };
  });
}

export async function expireQuestions(packageId?: string, groupId?: string, force = false, database: Pick<typeof db, "$transaction" | "clarification"> = db) {
  const expired = await database.clarification.findMany({ where: { ...(packageId ? { packageId } : {}), ...(groupId ? { OR: [{ groupId }, { id: groupId }] } : {}), status: "waiting", ...(force ? {} : { expiresAt: { lte: new Date() } }) }, take: 100 });
  for (const row of expired) {
    await database.$transaction(async (tx) => {
      const hasDefault = !!row.defaultAssumption?.trim();
      const status = hasDefault ? "defaulted" : row.priority === "blocking" ? "blocked" : "skipped";
      const updated = await tx.clarification.updateMany({ where: { id: row.id, status: "waiting" }, data: { status, answer: hasDefault ? row.defaultAssumption : null, answeredBy: hasDefault ? "timeout_default" : null, answeredAt: hasDefault ? new Date() : null } });
      if (!updated.count) return;
      await tx.researchPackage.update({ where: { id: row.packageId }, data: { contextVersion: { increment: 1 }, ...(status === "blocked" ? { status: "blocked" } : {}) } });
      if (ragEnabled() && hasDefault) await saveSource(tx, row.packageId, { sourceType: "clarification", sourceKey: `clarification:${row.id}`, title: row.question,
        content: `问题：${row.question}\n假设：${row.defaultAssumption}\n该假设尚未经用户确认。`, metadata: { clarificationId: row.id, answeredBy: "timeout_default", trust: "unconfirmed_assumption" } });
      await appendEvent(tx, row.packageId, "clarification_timeout", status === "blocked" ? "问题等待超时，研究已阻塞，仍可补充回答" : hasDefault ? "等待超时，已使用标注的默认假设" : "可选问题等待超时，保留待确认事项", { clarificationId: row.id, status, answered_by: hasDefault ? "timeout_default" : null });
      await resumeIfReady(tx, row.packageId, "澄清等待已结束，请读取答案和超时默认假设，再继续研究。");
    });
  }
}

export async function getAnswers(packageId: string, groupId: string, forceTimeout = false) {
  await expireQuestions(packageId, groupId, forceTimeout);
  const questions = await db.clarification.findMany({ where: { packageId, OR: [{ groupId }, { id: groupId }] }, orderBy: { createdAt: "asc" } });
  if (!questions.length) throw new ApiError(404, "未找到澄清请求。");
  const blocked = questions.some((q) => q.priority === "blocking" && q.status === "blocked");
  const waiting = questions.some((q) => q.status === "waiting");
  return { clarificationId: groupId, status: blocked ? "blocked" : waiting ? "waiting_for_user" : "answered", answers: questions.map((q) => ({ question: q.question, answer: q.answer, status: q.status, answered_by: q.answeredBy, priority: q.priority })), contextVersion: (await db.researchPackage.findUniqueOrThrow({ where: { id: packageId }, select: { contextVersion: true } })).contextVersion };
}
