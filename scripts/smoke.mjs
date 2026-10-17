import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";

const base = process.env.SCENARIOFORGE_BACKEND_URL ?? "http://localhost:3000";
const db = new PrismaClient();
let id;

async function internal(operation, data, packageId = id) {
  const response = await fetch(`${base}/api/internal/research/${packageId}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SCENARIOFORGE_INTERNAL_TOKEN}` }, body: JSON.stringify({ operation, data }) });
  const value = await response.json();
  assert.equal(response.ok, true, JSON.stringify(value));
  return value;
}

async function readEvent(after, expected) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(`${base}/api/research/${id}/stream?after=${after}`, { signal: abort.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes(`event: ${expected}`)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    return text;
  } finally { clearTimeout(timer); abort.abort(); }
}

try {
  const unauthenticated = await fetch(`${base}/api/internal/research/new`, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);
  const created = await internal("create", { goal: "ScenarioForge 自动验证专用临时研究包", constraints: {}, files: [] }, "new");
  id = created.id;
  const names = ["README.md", "RESEARCH.md", "DECISIONS.md", "PLAN.md", "SOURCES.md"];
  const filePlan = names.map((filename) => ({ filename, purpose: `验证 ${filename} 的独立职责`, priority: ["README.md", "RESEARCH.md", "SOURCES.md"].includes(filename) ? "required" : "recommended", contentOutline: ["验证下载与编辑流程"] }));
  await internal("plan", { scenarioType: "smoke", researchQuestions: ["问题一", "问题二", "问题三"], searchQueries: ["smoke"], unknowns: [], filePlan });
  const evidence = await internal("evidence", [{ question: "问题一", claim: "此记录仅用于验证，不是实际研究结论。", sources: [{ title: "测试来源", url: "https://example.com/", snippet: "fixture", accessedAt: new Date().toISOString() }], confidence: "low", impact: "测试", status: "unconfirmed" }]);
  assert.equal(evidence[0].code, "E001");
  const response = await fetch(`${base}/api/research/${id}`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.events.length, 2);
  assert.equal("sessionState" in snapshot, false);
  assert.equal("uploadedFiles" in snapshot, false);
  await readEvent(0, "planning_completed");
  const replay = await readEvent(1, "evidence_found");
  assert.equal(replay.includes("planning_completed"), false);
  for (const question of ["问题一", "问题二", "问题三"]) {
    await internal("begin_search", question);
    const result = await internal("search", { question, query: `smoke ${question}`, maxResults: 5 });
    assert.equal(result.provider, "mock"); assert.equal(result.results.length, 3);
    await internal("search_evidence", { question, cards: [{ question, claim: "测试数据不能作为已验证事实", sources: [{ ...result.results[0], accessedAt: result.fetchedAt }], confidence: "high", impact: "验证 Mock 来源保护", status: "verified" }] });
  }
  const searched = await internal("context");
  assert.equal(searched.searchedQuestions.length, 3);
  assert.equal(searched.searchCount, 3);
  assert.equal(searched.evidence.at(-1).status, "unconfirmed");
  assert.equal(searched.evidence.at(-1).confidence, "low");
  for (const filename of names) {
    const result = await internal("write_file", { filename, content: `# ${filename}\n\n自动验证内容`, base_version: 0, reason: "验证下载" });
    assert.equal(result.status, "created");
    const download = await fetch(`${base}/api/research/${id}/files/${filename}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await download.text(), `# ${filename}\n\n自动验证内容`);
  }
  const stale = await internal("write_file", { filename: "PLAN.md", content: "stale", base_version: 0, reason: "旧版本验证" });
  assert.equal(stale.status, "conflict");
  const zipResponse = await fetch(`${base}/api/research/${id}/workspace`);
  assert.equal(zipResponse.status, 200);
  const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), names.sort());
  assert.equal(await zip.file("PLAN.md").async("string"), "# PLAN.md\n\n自动验证内容");
  assert.equal((await fetch(`${base}/api/research/${id}/files/secret.txt`)).status, 400);
  await db.researchPackage.update({ where: { id }, data: { taskState: "running", leaseOwner: "smoke-check", leaseUntil: new Date(Date.now() + 120000) } });
  const fileUrl = `${base}/api/research/${id}/files/PLAN.md`;
  const lockToken = randomUUID();
  const locked = await fetch(fileUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock", baseVersion: 1, lockToken }) });
  assert.equal(locked.status, 200);
  const agentLocked = await internal("write_file", { filename: "PLAN.md", content: "agent replacement", base_version: 1, reason: "锁验证" });
  assert.equal(agentLocked.status, "locked");
  const otherLock = await fetch(fileUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock", lockToken: randomUUID() }) });
  assert.equal(otherLock.status, 423);
  const conflict = await fetch(fileUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: 2, content: "outdated user write", lockToken }) });
  assert.equal(conflict.status, 409);
  const userText = "# 用户保留内容\n\n这段文字必须始终保留。";
  const saved = await fetch(fileUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: 1, content: userText, changeNote: "用户调整计划", lockToken }) });
  assert.equal(saved.status, 200);
  const protectedWrite = await internal("write_file", { filename: "PLAN.md", content: "replacement", base_version: 2, reason: "保护验证" });
  assert.equal(protectedWrite.status, "user_modified");
  const append = await internal("write_file", { filename: "PLAN.md", content: `${userText}\n\nAI 补充建议。`, base_version: 2, reason: "保留用户原文" });
  assert.equal(append.status, "updated");
  const stillProtected = await internal("write_file", { filename: "PLAN.md", content: "replacement again", base_version: 3, reason: "持久保护验证" });
  assert.equal(stillProtected.status, "user_modified");
  assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id } })).pendingMessage.includes("read_workspace_file"), true);
  const first = await internal("ask", [{ question: "选择目标用户", type: "single_choice", options: ["学生", "所有人"], priority: "blocking", why_needed: "影响方案范围" }]);
  const questionId = first.questions[0].id;
  assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id } })).status, "waiting_for_user");
  const badAnswer = await fetch(`${base}/api/research/${id}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clarificationId: questionId, answer: "不存在的选项" }) });
  assert.equal(badAnswer.status, 400);
  const answer = await fetch(`${base}/api/research/${id}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clarificationId: questionId, answer: "学生" }) });
  assert.equal(answer.status, 200);
  const answered = await internal("answers", { clarificationId: first.clarificationId });
  assert.equal(answered.answers[0].answered_by, "user");
  assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id } })).status, "researching");
  const second = await internal("ask", [{ question: "预算", type: "text", priority: "blocking", why_needed: "需要预算", default_assumption: "低预算" }, { question: "活动地点", type: "text", priority: "blocking", why_needed: "必须确认地点" }]);
  const timed = await internal("answers", { clarificationId: second.clarificationId, timeout: true });
  assert.equal(timed.status, "blocked");
  assert.equal(timed.answers[0].answered_by, "timeout_default");
  assert.equal(timed.answers[1].status, "blocked");
  console.log("PASS: authentication, evidence, SSE replay, Markdown/ZIP, edit locking/conflicts, permanent user-content protection, Agent notification, clarification resume and timeout policies");
} finally {
  if (id) await db.researchPackage.delete({ where: { id } });
  await db.$disconnect();
}
