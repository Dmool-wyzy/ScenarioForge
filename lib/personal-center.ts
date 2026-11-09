import "server-only";
import { z } from "zod";
import { db } from "./db";
import { avatarSchema } from "./avatar";
import { contributionSummary } from "./contributions";

export const profileSchema = z.object({
  nickname: z.string().trim().max(40), avatar: avatarSchema,
  bio: z.string().trim().max(500), specialty: z.string().trim().max(100),
  skills: z.array(z.string().trim().min(1).max(30)).max(12).transform(v => [...new Set(v)]),
}).strict();
export const preferencesSchema = z.object({
  agentStyle: z.enum(["concise", "balanced", "detailed"]), agentTech: z.string().trim().max(500),
  agentDelivery: z.string().trim().max(500), agentNotes: z.string().trim().max(1000),
}).strict();
export const profileDefaults = { nickname: "", avatar: "leaf", bio: "", specialty: "", skills: [] as string[] };
export const preferenceDefaults = { agentStyle: "balanced", agentTech: "", agentDelivery: "", agentNotes: "" };

export async function personalCenter(userId: string) {
  const [user, stored, projects, growth] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true, createdAt: true } }),
    db.userProfile.findUnique({ where: { userId } }),
    db.projectMember.findMany({ where: { userId }, select: { project: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } }),
    contributionSummary(userId),
  ]);
  const { userId: omitted, skills, ...fields } = stored ?? { userId, ...profileDefaults, ...preferenceDefaults };
  void omitted;
  return { user, profile: { ...fields, skills: typeof skills === "string" ? JSON.parse(skills) : skills }, projects: projects.map(m => m.project), growth };
}

export async function personalAgentPreferences(userId: string) {
  const row = await db.userProfile.findUnique({ where: { userId }, select: { specialty: true, skills: true, agentStyle: true, agentTech: true, agentDelivery: true, agentNotes: true } });
  if (!row) return null;
  return { specialty: row.specialty, skills: JSON.parse(row.skills), responseStyle: row.agentStyle, preferredTechnology: row.agentTech, deliveryFormat: row.agentDelivery, notes: row.agentNotes };
}
