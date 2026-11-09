import "server-only";
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./errors";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function createInviteCode() { return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(""); }

function projectInclude(userId: string) {
  return {
    members: { where: { userId }, select: { role: true, personalPriority: true } },
    _count: { select: { members: true } },
    researchPackages: { orderBy: { updatedAt: "desc" as const }, select: { id: true, title: true, status: true, updatedAt: true } },
  };
}

export async function projectSummary(id: string, userId: string) {
  const project = await db.project.findFirst({ where: { id, members: { some: { userId } } }, include: projectInclude(userId) });
  if (!project) throw new ApiError(404, "未找到项目，或你尚未加入此项目。");
  return { id: project.id, name: project.name, inviteCode: project.inviteCode, role: project.members[0].role, stars: project.members[0].personalPriority?.stars ?? 3, sortOrder: project.members[0].personalPriority?.sortOrder ?? 0, createdAt: project.createdAt, memberCount: project._count.members, researchPackages: project.researchPackages };
}

export async function listProjects(userId: string) {
  const projects = await db.project.findMany({ where: { members: { some: { userId } } }, orderBy: { updatedAt: "desc" }, include: projectInclude(userId) });
  return projects.map(project => ({ id: project.id, name: project.name, inviteCode: project.inviteCode, role: project.members[0].role, stars: project.members[0].personalPriority?.stars ?? 3, sortOrder: project.members[0].personalPriority?.sortOrder ?? 0, createdAt: project.createdAt, memberCount: project._count.members, researchPackages: project.researchPackages }));
}

export async function createProject(name: string, userId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const project = await db.project.create({ data: { name, inviteCode: createInviteCode(), members: { create: { userId, role: "owner" } } } });
      return projectSummary(project.id, userId);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  throw new ApiError(503, "邀请码生成繁忙，请重试。");
}

export async function joinProject(inviteCode: string, userId: string) {
  const project = await db.project.findUnique({ where: { inviteCode } });
  if (!project) throw new ApiError(404, "邀请码无效，请检查后重试。");
  await db.projectMember.upsert({ where: { projectId_userId: { projectId: project.id, userId } }, create: { projectId: project.id, userId }, update: {} });
  return projectSummary(project.id, userId);
}
