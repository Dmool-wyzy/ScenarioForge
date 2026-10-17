import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
const { backfillPackage } = await import("../lib/rag/backfill");
const { db } = await import("../lib/db");
const dryRun = !process.argv.includes("--apply");
try {
  const selected = process.argv.find(arg => arg.startsWith("--package="))?.slice(10);
  const packages = await db.researchPackage.findMany({ where: selected ? { id: selected } : {}, select: { id: true }, orderBy: { createdAt: "asc" } });
  for (const pkg of packages) console.log(JSON.stringify({ dryRun, ...await backfillPackage(pkg.id, dryRun) }));
} finally { await db.$disconnect(); }
}
void main().catch(() => { console.error("回填失败，请检查数据库连接、迁移状态或旧数据格式。"); process.exitCode = 1; });
