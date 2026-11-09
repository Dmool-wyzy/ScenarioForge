import { randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

type Project = { id: string; name: string; inviteCode: string };

export const test = base.extend<{ project: Project }>({
  request: async ({ context }, provide) => { await provide(context.request); },
  project: [async ({ page, request, baseURL }, provide) => {
    const db = new PrismaClient();
    const suffix = randomBytes(8).toString("hex");
    const username = `browser_${suffix}`;
    let project: Project | undefined;
    try {
      const registration = await request.post("/api/auth/register", {
        headers: { Origin: new URL(baseURL!).origin, "X-Real-IP": `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}` },
        data: { username, password: randomBytes(24).toString("base64url") },
      });
      expect(registration.status()).toBe(200);
      const created = await request.post("/api/projects", { headers: { Origin: new URL(baseURL!).origin }, data: { name: `浏览器验证 ${suffix}` } });
      expect(created.status()).toBe(201);
      project = (await created.json()).project;
      await provide(project!);
    } finally {
      await page.goto("about:blank");
      try {
        if (project) {
          await db.$transaction(async tx => {
            await tx.knowledgeJob.deleteMany({ where: { package: { projectId: project!.id } } });
            await tx.evidence.deleteMany({ where: { package: { projectId: project!.id } } });
            await tx.researchPackage.deleteMany({ where: { projectId: project!.id } });
            await tx.project.delete({ where: { id: project!.id } });
          });
        }
        await db.user.deleteMany({ where: { username } });
      } finally { await db.$disconnect(); }
    }
  }, { auto: true }],
});

export { expect };
