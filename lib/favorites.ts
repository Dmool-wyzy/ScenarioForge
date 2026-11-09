import "server-only";
import { z } from "zod";
import { db } from "./db";
export const favoriteTarget = z.object({ kind: z.enum(["file", "evidence", "message", "reply", "research"]), targetId: z.string().regex(/^[A-Za-z0-9_.:-]{1,240}$/) }).strict();
export const favoriteDetails = z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(8).transform(v => [...new Set(v)]), note: z.string().trim().max(1000) }).strict();
// Store references, not copies. Content is resolved under current membership on every read.
export async function resolveFavorite(userId: string, kind: string, targetId: string) {
  const access = { project: { members: { some: { userId } } } };
  const link = (projectId: string, packageId: string) => `/?${new URLSearchParams({ project: projectId, package: packageId })}`;
  if (kind === "file") {
    const match = targetId.match(/^([A-Za-z0-9_-]+):([A-Za-z][A-Za-z0-9_-]{0,79}\.md)$/);
    if (!match) return null;
    const row = await db.workspaceFile.findFirst({ where: { packageId: match[1], filename: match[2], package: access }, select: { filename: true, content: true, packageId: true, package: { select: { projectId: true, title: true } } } });
    return row?.package.projectId ? { title: row.filename, content: row.content.slice(0, 1500), projectId: row.package.projectId, context: row.package.title, href: `${link(row.package.projectId, row.packageId)}&file=${encodeURIComponent(row.filename)}` } : null;
  }
  if (kind === "evidence") {
    const row = await db.evidence.findFirst({ where: { id: targetId, package: access }, select: { code: true, claim: true, question: true, sources: true, packageId: true, package: { select: { projectId: true, title: true } } } });
    return row?.package.projectId ? { title: `${row.code} · ${row.question.slice(0, 100)}`, content: row.claim.slice(0, 1500), projectId: row.package.projectId, context: row.package.title, href: `${link(row.package.projectId, row.packageId)}#saved-evidence-${targetId}` } : null;
  }
  if (kind === "reply") {
    const row = await db.researchEvent.findFirst({ where: { id: targetId, type: "assistant_message", package: access }, select: { message: true, packageId: true, package: { select: { projectId: true, title: true } } } });
    return row?.package.projectId ? { title: row.message.slice(0, 100), content: row.message.slice(0, 1500), projectId: row.package.projectId, context: row.package.title, href: `${link(row.package.projectId, row.packageId)}#research-reply-${targetId}` } : null;
  }
  if (kind === "research") {
    const row = await db.researchPackage.findFirst({ where: { id: targetId, ...access }, select: { id: true, projectId: true, title: true, summary: true } });
    return row?.projectId && row.summary ? { title: row.title, content: row.summary.slice(0, 1500), projectId: row.projectId, context: "研究结论", href: `${link(row.projectId, row.id)}#research-summary` } : null;
  }
  if (kind === "message") {
    const match = targetId.match(/^([A-Za-z0-9_-]+):(\d+)$/);
    if (!match) return null;
    const row = await db.agentSubtask.findFirst({ where: { id: match[1], assigneeId: userId, package: access }, select: { id: true, objective: true, conversation: true, packageId: true, package: { select: { projectId: true, title: true } } } });
    if (!row?.package.projectId) return null;
    const conversation: { role: string; content: string }[] = JSON.parse(row.conversation);
    const message = conversation[Number(match[2])];
    return message?.role === "assistant" ? { title: row.objective.slice(0, 100), content: message.content.slice(0, 1500), projectId: row.package.projectId, context: "个人 Agent 回复", href: `${link(row.package.projectId, row.packageId)}#personal-task-${row.id}` } : null;
  }
  return null;
}
