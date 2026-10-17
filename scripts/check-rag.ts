import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";

// Isolated SQLite and deterministic vectors. No real keys, search or model calls.
mkdirSync(".tmp", { recursive: true });
const database = resolve(`.tmp/rag-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${database.replaceAll("\\", "/")}`;
process.env.RAG_ENABLED = "true";
process.env.EMBEDDING_PROVIDER = "mock";
process.env.SEARCH_PROVIDER = "mock";
process.env.RAG_MIN_SCORE = "0.05";
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe", windowsHide: true });

test("RAG: chunking, embeddings, isolation, versions, recovery and citations", async () => {
  const { db } = await import("../lib/db");
  const { chunkText } = await import("../lib/rag/chunking");
  const { embedTexts, validateVectors } = await import("../lib/rag/embedding");
  const { addSource } = await import("../lib/rag/sources");
  const { processPackageIndex, queueRebuild } = await import("../lib/rag/indexing");
  const { searchEvidence, getEvidence } = await import("../lib/rag/retrieval");
  const { createResearch, savePlan } = await import("../lib/research");
  const { backfillPackage } = await import("../lib/rag/backfill");
  const { prepareFileContext } = await import("../lib/rag/context");
  const { writeWorkspaceFile } = await import("../lib/files");
  const { extractCitations } = await import("../lib/rag/citations");
  const { isPublicIPv4 } = await import("../lib/rag/fetch-source");
  const { exportWorkspace } = await import("../lib/markdown");
  try {
    const code = '```python\nprint("安全帽")\n```';
    const table = "| 类别 | 标注 |\n| --- | --- |\n| 安全帽 | 框 |";
    const chunks = chunkText(`# 数据集\n\n${"中文证据说明。".repeat(260)}\n\n${code}\n\n${table}`, 800, 120);
    assert.ok(chunks.length > 2);
    assert.ok(chunks.every(row => row.content && row.tokenCount > 0));
    assert.ok(chunks.some(row => row.content.includes(code)));
    assert.ok(chunks.some(row => row.content.includes(table)));
    assert.throws(() => validateVectors([[0, 0]], 1));
    assert.throws(() => validateVectors([[1, Number.NaN]], 1));
    assert.throws(() => validateVectors([[1, 0], [1]], 2));
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "100.64.0.1"]) assert.equal(isPublicIPv4(ip), false);
    assert.equal(isPublicIPv4("8.8.8.8"), true);
    assert.deepEqual(extractCitations("正文 [EVIDENCE-1]\n`[EVIDENCE-2]`\n```\n[EVIDENCE-3]\n```" ).map(row => row.evidenceId), ["EVIDENCE-1"]);
    const fixtures = [
      { goal: "我想做一个东京留学生合租平台", text: "东京留学生合租平台优先支持中文和日文；首版只做房源信息展示，租赁价格与法律条款待确认。", query: "东京留学生合租平台 中文日文 房源" },
      { goal: "我要做一个基于 YOLO 的安全帽检测项目", text: "YOLO 安全帽检测项目：标注类别是安全帽、未佩戴安全帽。使用边界框。数据集许可证与训练指标待确认。", query: "YOLO 安全帽检测 标注类别 边界框" },
      { goal: "我想组织一次校园社团活动", text: "校园社团活动预算 3000 元，参加人数 50 人，地点为校内礼堂；这些是用户给定的活动约束。", query: "校园社团活动 预算 人数 地点" },
    ];
    const packages = [];
    for (const fixture of fixtures) {
      const pkg = await createResearch({ goal: fixture.goal, files: [{ filename: "reference.txt", extractedText: fixture.text }] });
      packages.push(pkg);
      await processPackageIndex(pkg.id);
      const hits = await searchEvidence(pkg.id, { query: fixture.query, sourceTypes: ["upload"] });
      assert.equal(hits.status, "ok");
      assert.ok(hits.results.some(hit => hit.content.includes(fixture.text)));
      assert.ok(hits.results.every(hit => !fixtures.filter(other => other !== fixture).some(other => hit.content.includes(other.text))));
      const count = await db.chunkEmbedding.count({ where: { packageId: pkg.id } });
      await processPackageIndex(pkg.id);
      assert.equal(await db.chunkEmbedding.count({ where: { packageId: pkg.id } }), count);
      const version = (await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } })).contextVersion;
      await backfillPackage(pkg.id); await backfillPackage(pkg.id);
      assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } })).contextVersion, version);
    }
    const packageId = packages[1].id;
    const old = await addSource(packageId, { sourceType: "clarification", sourceKey: "clarify:test", title: "训练设备", content: "用户确认训练设备为 GPU，型号待确认。", metadata: { trust: "user_confirmed" } });
    await processPackageIndex(packageId);
    const oldChunk = await db.evidenceChunk.findFirstOrThrow({ where: { packageId, sourceRevisionId: old!.revisionId } });
    await addSource(packageId, { sourceType: "clarification", sourceKey: "clarify:test", title: "训练设备", content: "用户确认训练设备为 CPU，暂不使用 GPU。", metadata: { trust: "user_confirmed" } });
    await processPackageIndex(packageId);
    assert.equal((await getEvidence(packageId, `EVIDENCE-${oldChunk.evidenceNumber}`)).source.current, false);
    const clarification = await searchEvidence(packageId, { query: "训练设备", sourceTypes: ["clarification"] });
    assert.ok(clarification.results.every(hit => hit.content.includes("CPU")));
    assert.equal((await searchEvidence(packageId, { query: "完全不相关查询", sourceTypes: ["web"] })).status, "insufficient_evidence");
    await assert.rejects(getEvidence(packages[0].id, "EVIDENCE-999999"));
    const filePlan = ["README.md", "RESEARCH.md", "SOURCES.md"].map(filename => ({ filename, purpose: "YOLO 安全帽检测 标注类别", priority: "required", contentOutline: ["安全帽检测项目目标和约束"] }));
    await savePlan(packageId, { scenarioType: "fixture", researchQuestions: ["问题1", "问题2", "问题3"], searchQueries: ["fixture"], unknowns: [], filePlan });
    for (const question of ["问题1", "问题2", "问题3"]) await db.researchEvent.create({ data: { packageId, type: "search_completed", message: "fixture", sequence: 10000 + Number(question.slice(-1)), payload: JSON.stringify({ question }) } });
    await db.evidence.create({ data: { packageId, code: "E001", question: "问题1", claim: "fixture", sources: "[]", confidence: "low", impact: "fixture", status: "unconfirmed" } });
    const context = await prepareFileContext(packageId, "README.md");
    const content = `# YOLO\n安全帽检测项目依据资料规划。[${context.retrieval.results[0].evidenceId}]`;
    await assert.rejects(writeWorkspaceFile(packageId, { filename: "README.md", content: "伪造事实 [EVIDENCE-999999]", base_version: 0, reason: "fixture", rag: context.rag }));
    assert.equal(await db.citation.count({ where: { packageId } }), 0);
    assert.equal((await writeWorkspaceFile(packageId, { filename: "README.md", content, base_version: 0, reason: "fixture", rag: context.rag })).status, "created");
    assert.ok(await db.citation.count({ where: { packageId } }));
    await assert.rejects(writeWorkspaceFile(packageId, { filename: "README.md", content, base_version: 1, reason: "fixture", rag: context.rag }), /资料|澄清/);
    const zip = await (await import("jszip")).default.loadAsync(await exportWorkspace(packageId));
    assert.ok(zip.file("evidence-index.json"));
    // Expired leases can be recovered without replacing stable evidence IDs.
    const job = await db.knowledgeJob.findFirstOrThrow({ where: { packageId, indexId: { not: null } } });
    await db.knowledgeJob.update({ where: { id: job.id }, data: { status: "running", leaseOwner: "crashed", leaseUntil: new Date(0) } });
    await processPackageIndex(packageId);
    assert.equal((await db.knowledgeJob.findUniqueOrThrow({ where: { id: job.id } })).status, "completed");
    const active = (await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } })).activeIndexId;
    process.env.EMBEDDING_PROVIDER = "openai_compatible";
    process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.EMBEDDING_MODEL = "different-model";
    process.env.EMBEDDING_API_KEY = "fixture-only";
    assert.equal((await searchEvidence(packageId, { query: "安全帽" })).status, "index_rebuild_required");
    assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } })).activeIndexId, active);
    // Verify compatible HTTP embeddings ordering and invalid-vector rejection.
    let invalid = false;
    const server = http.createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body).input;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: input.map((_: string, index: number) => ({ index, embedding: invalid ? [0, 0] : [index + 1, 1] })).reverse() }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      assert.deepEqual(await embedTexts(["first", "second"]), [[1, 1], [2, 1]]);
      invalid = true; await assert.rejects(embedTexts(["invalid"]));
      await queueRebuild(packageId);
      await assert.rejects(processPackageIndex(packageId));
      assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } })).activeIndexId, active);
      assert.ok(await db.knowledgeJob.count({ where: { packageId, status: "failed" } }));
    } finally { await new Promise<void>(done => server.close(() => done())); }
  } finally { await db.$disconnect(); for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(database + suffix, { force: true }); }
});
