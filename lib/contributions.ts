import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { ApiError } from "./errors";
import { CONTRIBUTION_RULES, contributionLevel } from "./contribution-levels";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const contributionAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), projectId: id, kind: z.enum(["task", "knowledge", "milestone"]), targetId: id, note: z.string().trim().min(10, "请至少用 10 个字说明检查内容或采纳理由。").max(600) }).strict(),
  z.object({ action: z.literal("revoke"), projectId: id, recordId: id, note: z.string().trim().min(5, "请填写至少 5 个字的撤销原因。").max(600) }).strict(),
]);
type Tx = Prisma.TransactionClient;
async function owner(tx: Tx, userId: string, projectId: string) {
  const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
  if (member?.role !== "owner") throw new ApiError(403, "只有项目创建者可以认可或撤销贡献。");
}

async function transaction<T>(run: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 }); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof Prisma.PrismaClientKnownRequestError) || !["P2034", "P2002"].includes(error.code)) throw error;
    }
  }
}

async function credit(tx: Tx, data: { userId: string; projectId: string; packageId: string; sourceKey: string; kind: "task" | "knowledge" | "review" | "milestone"; title: string; confirmedBy: string; note: string }) {
  const existing = await tx.contributionRecord.findUnique({ where: { userId_sourceKey: { userId: data.userId, sourceKey: data.sourceKey } } });
  if (existing && !existing.revokedAt) return existing;
  const values = { ...data, title: data.title.slice(0, 240), points: CONTRIBUTION_RULES[data.kind].points, revokedAt: null, revokeReason: "" };
  return existing ? tx.contributionRecord.update({ where: { id: existing.id }, data: values }) : tx.contributionRecord.create({ data: values });
}

export async function changeContribution(userId: string, raw: unknown) {
  const input = contributionAction.parse(raw);
  return transaction(async tx => {
    await owner(tx, userId, input.projectId);
    if (input.action === "revoke") {
      const record = await tx.contributionRecord.findFirst({ where: { id: input.recordId, projectId: input.projectId } });
      if (!record) throw new ApiError(404, "未找到此项目的贡献记录。");
      if (record.kind === "review") throw new ApiError(400, "请撤销对应任务或成果认定，审查经验会一并回退。");
      const sourceKeys = [record.sourceKey, `review:${record.sourceKey}`];
      await tx.contributionRecord.updateMany({ where: { projectId: input.projectId, sourceKey: { in: sourceKeys }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: input.note } });
      if (["task", "knowledge"].includes(record.kind)) {
        const stillContributing = await tx.contributionRecord.count({ where: { projectId: input.projectId, packageId: record.packageId, userId: record.userId, kind: { in: ["task", "knowledge"] }, revokedAt: null } });
        if (!stillContributing) await tx.contributionRecord.updateMany({ where: { projectId: input.projectId, packageId: record.packageId, userId: record.userId, kind: "milestone", revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "本阶段的有效交付与成果认定均已撤销。" } });
      }
      return { ok: true };
    }
    const { projectId, kind, targetId, note } = input;
    const sourceKey = `${kind}:${targetId}`;
    if (kind === "milestone") {
      const pkg = await tx.researchPackage.findFirst({ where: { id: targetId, projectId, status: "completed" } });
      if (!pkg) throw new ApiError(409, "只有已完成的研究包可以确认为里程碑。");
      const members = await tx.projectMember.findMany({ where: { projectId }, select: { userId: true } });
      const participants = await tx.contributionRecord.findMany({ where: { projectId, packageId: pkg.id, userId: { in: members.map(m => m.userId) }, kind: { in: ["task", "knowledge"] }, revokedAt: null }, distinct: ["userId"], select: { userId: true } });
      if (!participants.length) throw new ApiError(409, "请先认可本阶段的任务交付或成果，再确认里程碑。");
      for (const participant of participants) await credit(tx, { userId: participant.userId, projectId, packageId: pkg.id, sourceKey, kind, title: pkg.title, confirmedBy: userId, note });
      return { ok: true };
    }
    let recipient: string | null, packageId: string, title: string;
    if (kind === "task") {
      const task = await tx.agentSubtask.findFirst({ where: { id: targetId, package: { projectId }, status: "submitted" } });
      if (!task?.result) throw new ApiError(409, "任务尚未提交有效交付，不能计入经验。");
      recipient = task.assigneeId; packageId = task.packageId; title = task.objective;
    } else {
      const item = await tx.projectKnowledgeItem.findFirst({ where: { id: targetId, projectId, archivedAt: null } });
      if (!item) throw new ApiError(409, "共享成果已归档或不存在。");
      recipient = item.createdBy; packageId = item.originPackageId; title = item.title;
    }
    if (!recipient || !await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: recipient } } })) throw new ApiError(409, "贡献者已不在此项目中。");
    const prior = await tx.contributionRecord.findUnique({ where: { userId_sourceKey: { userId: recipient, sourceKey } } });
    if (prior && !prior.revokedAt) return { ok: true };
    await credit(tx, { userId: recipient, projectId, packageId, sourceKey, kind, title, confirmedBy: userId, note });
    if (recipient !== userId) await credit(tx, { userId, projectId, packageId, sourceKey: `review:${sourceKey}`, kind: "review", title: `审查：${title}`, confirmedBy: userId, note });
    return { ok: true };
  });
}

export async function contributionSummary(userId: string) {
  const groups = await db.contributionRecord.groupBy({ by: ["kind"], where: { userId, revokedAt: null }, _sum: { points: true }, _count: { _all: true } });
  const total = groups.reduce((sum, row) => sum + (row._sum.points ?? 0), 0);
  return { ...contributionLevel(total), counts: Object.fromEntries(Object.keys(CONTRIBUTION_RULES).map(kind => [kind, groups.find(row => row.kind === kind)?._count._all ?? 0])) };
}

export function contributionHref(projectId: string, packageId: string, sourceKey: string) {
  const key = sourceKey.replace(/^review:/, "");
  const [kind, target] = key.split(":");
  const base = `/?${new URLSearchParams({ project: projectId, package: packageId })}`;
  return kind === "task" ? `${base}#delivery-${target}` : kind === "milestone" ? `${base}#research-summary` : `/?${new URLSearchParams({ project: projectId })}#project-knowledge`;
}

export async function listContributions(userId: string, projectId: string | null, page: number) {
  const memberships = await db.projectMember.findMany({ where: { userId }, select: { role: true, project: { select: { id: true, name: true } } } });
  if (projectId && !memberships.some(m => m.project.id === projectId)) throw new ApiError(404, "未找到可访问的项目。");
  const where = { userId, ...(projectId ? { projectId } : {}) };
  const [summary, total, records] = await Promise.all([
    contributionSummary(userId), db.contributionRecord.count({ where }),
    db.contributionRecord.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 20 }),
  ]);
  return { summary, total, page, projects: memberships.map(m => ({ ...m.project, role: m.role })), records: records.map(record => {
    const member = memberships.find(m => m.project.id === record.projectId);
    return { id: record.id, kind: record.kind, points: record.points, createdAt: record.createdAt, revokedAt: record.revokedAt,
      title: member ? record.title : "历史项目贡献", note: member ? record.note : "项目已不可访问，已获得的贡献经验保留。", revokeReason: member ? record.revokeReason : "",
      projectName: member?.project.name ?? "项目已不可访问", href: member ? record.kind === "task"
        ? `/?${new URLSearchParams({ project: member.project.id, package: record.packageId })}#personal-task-${record.sourceKey.split(":")[1]}`
        : contributionHref(member.project.id, record.packageId, record.sourceKey) : null };
  }) };
}

export async function contributionReview(userId: string, projectId: string) {
  await owner(db, userId, projectId);
  const [tasks, knowledge, packages, records, members] = await Promise.all([
    db.agentSubtask.findMany({ where: { package: { projectId }, status: "submitted", assigneeId: { not: null } }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.projectKnowledgeItem.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.researchPackage.findMany({ where: { projectId, status: "completed" }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, summary: true } }),
    db.contributionRecord.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
    db.projectMember.findMany({ where: { projectId }, select: { userId: true, user: { select: { username: true } } } }),
  ]);
  const names = new Map(members.map(m => [m.userId, m.user.username]));
  const candidates = [
    ...tasks.filter(t => t.assigneeId && names.has(t.assigneeId) && t.result).map(t => ({ kind: "task", targetId: t.id, packageId: t.packageId, title: t.objective, content: t.result!, author: names.get(t.assigneeId!)!, eligible: true })),
    ...knowledge.filter(k => names.has(k.createdBy)).map(k => ({ kind: "knowledge", targetId: k.id, packageId: k.originPackageId, title: k.title, content: k.claim, author: names.get(k.createdBy)!, eligible: !k.archivedAt })),
    ...packages.map(p => { const participants = new Set(records.filter(r => r.packageId === p.id && ["task", "knowledge"].includes(r.kind) && !r.revokedAt && names.has(r.userId)).map(r => r.userId));
      return { kind: "milestone", targetId: p.id, packageId: p.id, title: p.title, content: p.summary ?? "研究已完成。", author: `${participants.size} 位有效贡献者`, eligible: participants.size > 0 }; }),
  ].map(candidate => {
    const key = `${candidate.kind}:${candidate.targetId}`, matching = records.filter(r => r.sourceKey === key);
    const active = matching.filter(r => !r.revokedAt);
    return { ...candidate, content: candidate.content.slice(0, 12000), href: contributionHref(projectId, candidate.packageId, key),
      recognized: active.length > 0, recordId: (active[0] ?? matching[0])?.id ?? null, note: (active[0] ?? matching[0])?.note ?? "" };
  });
  // Keep recognized entries revocable even if the original source is deleted, archived or outside the recent window.
  for (const record of records) {
    if (record.kind === "review" || record.revokedAt) continue;
    const targetId = record.sourceKey.split(":")[1];
    if (candidates.some(c => c.kind === record.kind && c.targetId === targetId)) continue;
    candidates.push({ kind: record.kind, targetId, packageId: record.packageId, title: record.title, content: "原始来源已不可用；可以复核并撤销已有认定。", author: names.get(record.userId) ?? "历史成员", eligible: false,
      href: `/?project=${encodeURIComponent(projectId)}`, recognized: true, recordId: record.id, note: record.note });
  }
  return { candidates, limited: tasks.length === 100 || knowledge.length === 100 || packages.length === 100 };
}
