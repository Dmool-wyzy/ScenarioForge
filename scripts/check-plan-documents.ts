import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage, type Model } from "@openai/agents";
import { db } from "../lib/db";
import { saveUserFile, updateFileLock } from "../lib/editing";
import { answerQuestion, expireQuestions } from "../lib/clarifications";
import { assertDocumentQueueReady, assertDocumentSnapshot, confirmDocumentProposal, DOCUMENTS_DRAFTING, DOCUMENTS_PLAN_READY, generatePlanDocuments, planDocumentsFromOutput, queuePlanDocuments, readDocumentProposal, saveGeneratedPlanDocuments } from "../lib/plan-documents";
import { assertExecutionResearchReady } from "../lib/workspace-agent/store";
import { documentSelectionSchema, recommendDocuments, type DocumentSpec } from "../lib/document-proposal";
import { queueResearchInTransaction } from "../lib/tasks";
import { taskOutcome } from "../lib/task-outcome";

const output = { plan: "# 实施方案\n\n目标：实现加法模块。范围：Node 内置能力。假设：使用已有 Node 环境。验收：由执行 Agent 创建测试并运行，不声称已通过。", tasks: "# 任务清单\n\n- [ ] 创建模块\n- [ ] 创建 Node 内置测试\n- [ ] 请求运行测试\n- [ ] 检查退出码与测试断言\n- [ ] 生成人工审查报告" };
const file = () => ({ filename: "PLAN.md", version: 1, content: "# Original", lockedBy: null as string | null, userContent: null as string | null, updatedBy: "agent" });
const lease = () => ({ status: DOCUMENTS_DRAFTING, taskState: "running", leaseOwner: "worker-one", leaseUntil: new Date(Date.now() + 60_000), contextVersion: 4 });
const selectedDocuments: DocumentSpec[] = [
  { filename: "PLAN.md", purpose: "总体方案", contentOutline: ["目标、约束与实施步骤"] },
  { filename: "TASKS.md", purpose: "验收任务", contentOutline: ["执行任务与验证标准"] },
  { filename: "API_DESIGN.md", purpose: "接口约定", contentOutline: ["请求响应与错误处理"] },
];

test("new discussion makes the existing document proposal stale before an ordinary chat reply and prevents confirmation", async () => {
  const proposal = { id: "proposal-one", request: "创建加法模块", contextVersion: 4, documents: selectedDocuments };
  for (const taskState of ["idle", "queued", "running"]) {
    const pkg = { status: DOCUMENTS_PLAN_READY, taskState, leaseUntil: taskState === "running" ? new Date(Date.now() + 60_000) : null,
      pendingMessage: taskState === "idle" ? null : "earlier message", contextVersion: 4, eventSequence: 1,
      projectId: "project-one", files: [], currentStage: 0, researchPlan: null };
    const events = [{ type: "documents_plan_proposed", message: "proposal", payload: JSON.stringify({ proposal, userId: "user-one", files: [] }) }];
    const tx = {
      $queryRaw: async () => [],
      researchPackage: {
        findUniqueOrThrow: async () => pkg,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) {
            (pkg as Record<string, unknown>)[key] = value && typeof value === "object" && "increment" in value
              ? Number((pkg as Record<string, unknown>)[key]) + Number(value.increment) : value;
          }
          return pkg;
        },
      },
      projectMember: { findUnique: async () => ({ userId: "user-one" }) },
      researchEvent: {
        findFirst: async () => events[0],
        create: async ({ data }: { data: typeof events[number] }) => { events.push(data); return data; },
      },
    };
    const initialPending = pkg.pendingMessage;
    await queueResearchInTransaction(tx as unknown as Parameters<typeof queueResearchInTransaction>[0], "package-one", "增加数据库设计要求", true);
    assert.equal(pkg.contextVersion, 5);
    assert.equal(pkg.taskState, taskState === "running" ? "running" : "queued");
    assert.equal(pkg.pendingMessage, [initialPending, "增加数据库设计要求"].filter(Boolean).join("\n"));
    assert.equal(events.filter(event => event.type === "user_message").length, 1);
    assert.deepEqual(readDocumentProposal(events, pkg), proposal, "keep the old editable proposal visible with its original context version");
    // A plain chat reply preserves document mode, so the version must already have changed at enqueue time.
    Object.assign(pkg, taskOutcome(pkg, false, []), { taskState: "idle", pendingMessage: null });
    const database = { $transaction: (async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)) as typeof db.$transaction };
    await assert.rejects(confirmDocumentProposal("package-one", proposal.id, selectedDocuments, "user-one", database), /清单已过期/);
  }
});

test("proposal invalidation only tracks new user discussion and preserves the drafting rejection", async () => {
  for (const status of [DOCUMENTS_PLAN_READY, DOCUMENTS_DRAFTING, "documents_ready", "researching"]) for (const userMessage of [false, true]) {
    const pkg = { status, taskState: "idle", pendingMessage: null, leaseUntil: null, contextVersion: 4, eventSequence: 0 };
    const updates: Record<string, unknown>[] = [];
    const tx = {
      $queryRaw: async () => [],
      researchPackage: { findUniqueOrThrow: async () => pkg, update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return pkg; } },
      researchEvent: { create: async () => ({}) },
    };
    const queuing = queueResearchInTransaction(tx as unknown as Parameters<typeof queueResearchInTransaction>[0], "package-one", "next message", userMessage);
    if (status === DOCUMENTS_DRAFTING && userMessage) {
      await assert.rejects(queuing, /方案文档正在生成/);
      assert.equal(updates.length, 0);
    } else {
      await queuing;
      assert.deepEqual(updates[0].contextVersion, status === DOCUMENTS_PLAN_READY && userMessage ? { increment: 1 } : undefined);
      assert.equal(updates.filter(update => "contextVersion" in update).length, status === DOCUMENTS_PLAN_READY && userMessage ? 1 : 0);
    }
  }
});

test("optional clarification timeouts invalidate previews and in-flight documents without starting another model task", async () => {
  const previousRag = process.env.RAG_ENABLED;
  process.env.RAG_ENABLED = "false";
  try {
    for (const status of [DOCUMENTS_PLAN_READY, DOCUMENTS_DRAFTING]) for (const defaultAssumption of [null, "使用 SQLite 数据库"]) {
      const pkg = { ...lease(), status, taskState: status === DOCUMENTS_DRAFTING ? "running" : "idle", pendingMessage: null, eventSequence: 1 };
      const proposal = { id: "proposal-one", request: "创建加法模块", contextVersion: pkg.contextVersion, documents: selectedDocuments };
      const events = [{ type: "documents_plan_proposed", payload: { proposal, userId: "user-one", files: [] } as unknown }];
      const question = { id: "question-one", packageId: "package-one", question: "使用哪个数据库？", priority: "optional", status: "waiting", defaultAssumption, answer: null as string | null };
      const tx = {
        clarification: {
          count: async () => 0,
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            if (question.status !== "waiting") return { count: 0 };
            Object.assign(question, data);
            return { count: 1 };
          },
        },
        researchPackage: {
          findUniqueOrThrow: async () => pkg,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            for (const [key, value] of Object.entries(data)) {
              (pkg as Record<string, unknown>)[key] = value && typeof value === "object" && "increment" in value
                ? Number((pkg as Record<string, unknown>)[key]) + Number(value.increment) : value;
            }
            return pkg;
          },
        },
        researchEvent: { create: async ({ data }: { data: typeof events[number] }) => { events.push(data); return data; } },
      };
      // Return the same row twice to model a second scheduler which listed it before the first committed.
      const database = { clarification: { findMany: async () => [question] },
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx) } as unknown as Parameters<typeof expireQuestions>[3];
      await expireQuestions("package-one", undefined, false, database);
      await expireQuestions("package-one", undefined, false, database);
      assert.equal(question.status, defaultAssumption ? "defaulted" : "skipped");
      assert.equal(question.answer, defaultAssumption);
      assert.equal(pkg.contextVersion, 5, "a timeout changes context only once even if two schedulers listed the same row");
      assert.equal(pkg.status, status);
      assert.equal(pkg.taskState, status === DOCUMENTS_DRAFTING ? "running" : "idle");
      assert.equal(pkg.pendingMessage, null);
      assert.equal(events.filter(event => event.type === "clarification_timeout").length, 1);
      if (status === DOCUMENTS_PLAN_READY) assert.deepEqual(readDocumentProposal(events, pkg), proposal);
      else assert.throws(() => assertDocumentSnapshot(pkg, "worker-one", proposal.contextVersion, [], []), /资料或文档已变化/);
    }
  } finally {
    if (previousRag === undefined) delete process.env.RAG_ENABLED;
    else process.env.RAG_ENABLED = previousRag;
  }
});

test("document proposals recommend a minimal set and allow safe custom lists instead of forcing two names", () => {
  assert.deepEqual(recommendDocuments("创建一个加法模块并测试").map(item => item.filename), ["PLAN.md", "TASKS.md"]);
  assert.ok(recommendDocuments("设计系统架构、REST API接口与数据库表结构，并记录风险").length > 2);
  assert.equal(documentSelectionSchema.parse([{ filename: "EXPERIMENT.md", purpose: "研究实验", contentOutline: ["假设与评估指标"] }]).length, 1);
  for (const documents of [[], [selectedDocuments[0], { ...selectedDocuments[0], filename: "plan.md" }],
    [{ ...selectedDocuments[0], filename: "../PLAN.md" }], [{ ...selectedDocuments[0], filename: "CON.md" }],
    [{ ...selectedDocuments[0], filename: "secrets.txt" }], Array.from({ length: 21 }, (_, index) => ({ ...selectedDocuments[0], filename: `DOC${index}.md` }))]) {
    assert.equal(documentSelectionSchema.safeParse(documents).success, false);
  }
});

test("the real SDK generates exactly the confirmed custom set in one call without execution tools", async () => {
  let calls = 0;
  const documents = selectedDocuments.map(document => ({ filename: document.filename, content: output.plan + "\n\n" + document.purpose }));
  const model: Model = {
    async getResponse(request) {
      calls++;
      assert.equal(request.tools.length, 0);
      assert.match(JSON.stringify(request.input) + request.systemInstructions, /API_DESIGN.md/);
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ documents }) }] }] };
    }, getStreamedResponse() { throw new Error("unused"); },
  };
  const generated = await generatePlanDocuments({ model, documents: selectedDocuments, input: "按已确认文档清单整理接口设计", signal: new AbortController().signal });
  assert.equal(calls, 1);
  assert.deepEqual(generated.documents.map(document => document.filename), selectedDocuments.map(document => document.filename));
  for (const invalid of [documents.slice(0, 2), [...documents, { filename: "EXTRA.md", content: output.plan }], [documents[0], documents[0], documents[2]]]) {
    assert.throws(() => planDocumentsFromOutput({ documents: invalid }, selectedDocuments));
  }
});

test("explicit document action produces real skill documents through one SDK call, without research or execution tools", async () => {
  let calls = 0;
  const model: Model = {
    async getResponse(request) {
      calls++;
      assert.equal(request.tools.length, 0);
      assert.match(JSON.stringify(request.input), /加法模块/);
      assert.match(request.systemInstructions ?? "", /不联网、不执行代码/);
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  const result = await generatePlanDocuments({ model, input: JSON.stringify({ goal: "创建加法模块" }), signal: new AbortController().signal });
  assert.equal(calls, 1);
  assert.deepEqual(result.documents.map(document => document.filename), ["PLAN.md", "TASKS.md"]);
  for (const document of result.documents) assert.match(document.content, /不代表已联网核实、已修改项目或已通过测试/);
});

test("invalid or oversized output cannot be treated as saved documents", async () => {
  for (const value of ["just a chat reply", { plan: output.plan }, { ...output, tasks: "" }, { ...output, plan: "x".repeat(12001) }, { ...output, filename: "../secret.md" }]) {
    assert.throws(() => planDocumentsFromOutput(value), /未返回完整有效/);
  }
  let called = false;
  const model: Model = { async getResponse() { called = true; throw new Error("must not call"); }, getStreamedResponse() { throw new Error("unused"); } };
  await assert.rejects(generatePlanDocuments({ model, input: "x".repeat(50001), signal: new AbortController().signal }), /50000/);
  assert.equal(called, false);
});

test("a malformed model response stops after one call instead of silently retrying", async () => {
  let calls = 0;
  const model: Model = {
    async getResponse() {
      calls++;
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ plan: output.plan }) }] }] };
    },
    getStreamedResponse() { throw new Error("unused"); },
  };
  await assert.rejects(generatePlanDocuments({ model, input: "创建加法模块", signal: new AbortController().signal }));
  assert.equal(calls, 1);
});

test("document queue refuses active work, blocked clarification, locks and human-edited target files", () => {
  const pkg = { status: "replied", taskState: "idle", pendingMessage: null as string | null };
  assert.doesNotThrow(() => assertDocumentQueueReady(pkg, [], 0, 0));
  assert.throws(() => assertDocumentQueueReady({ ...pkg, taskState: "running" }, [], 0, 0), /待处理任务/);
  assert.throws(() => assertDocumentQueueReady({ ...pkg, pendingMessage: "existing request" }, [], 0, 0), /待处理任务/);
  assert.throws(() => assertDocumentQueueReady(pkg, [], 0, 1), /工作区任务正在执行/);
  assert.throws(() => assertDocumentQueueReady(pkg, [], 1, 0), /阻塞澄清/);
  assert.throws(() => assertDocumentQueueReady(pkg, [{ ...file(), lockedBy: "alice" }], 0, 0), /正在编辑/);
  assert.throws(() => assertDocumentQueueReady(pkg, [{ ...file(), userContent: "my draft" }], 0, 0), /不会覆盖/);
  assert.throws(() => assertDocumentQueueReady(pkg, [{ ...file(), updatedBy: "user" }], 0, 0), /不会覆盖/);
  assert.doesNotThrow(() => assertDocumentQueueReady(pkg, [{ ...file(), filename: "NOTES.md", userContent: "user notes" }], 0, 0));
  const editedDesign = { ...file(), filename: "API_DESIGN.md", updatedBy: "user", userContent: "User interface design" };
  assert.throws(() => assertDocumentQueueReady(pkg, [editedDesign], 0, 0, ["API_DESIGN.md"]), /不会覆盖/);
  assert.doesNotThrow(() => assertDocumentQueueReady(pkg, [editedDesign], 0, 0, ["NEW_DESIGN.md"]));
  assert.throws(() => assertDocumentQueueReady(pkg, [{ ...editedDesign, updatedBy: "agent", userContent: null }], 0, 0, ["api_design.md"]), /大小写冲突/);
});

test("the explicit document request remains visible in chat without duplicating the original or latest user message", async () => {
  for (const request of [undefined, "补充要求：使用 Node 内置测试", "上次已经发送的要求"]) {
    const pkg = { status: "replied", taskState: "idle", pendingMessage: null as string | null, projectId: "project-one", goal: "创建加法模块", files: [], eventSequence: 0 };
    const events: { type: string; message: string }[] = [];
    const tx = {
      $queryRaw: async () => [],
      researchPackage: { findUniqueOrThrow: async () => pkg, update: async () => ({ eventSequence: ++pkg.eventSequence }) },
      projectMember: { findUnique: async () => ({ userId: "user-one" }) },
      clarification: { count: async () => 0 }, workspaceExecution: { count: async () => 0 },
      researchEvent: { findFirst: async () => ({ message: "上次已经发送的要求" }), create: async ({ data }: { data: { type: string; message: string } }) => { events.push(data); return data; } },
    };
    const database = { $transaction: (async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)) as typeof db.$transaction };
    await queuePlanDocuments("package-one", request, "user-one", database);
    assert.deepEqual(events.map(event => event.type), request?.startsWith("补充要求") ? ["user_message", "documents_requested"] : ["documents_requested"]);
    if (request?.startsWith("补充要求")) assert.equal(events[0].message, request);
  }
});

test("stale workers, changed sources and concurrent document edits cannot overwrite the current document version", () => {
  const baseline = [file()];
  assert.doesNotThrow(() => assertDocumentSnapshot(lease(), "worker-one", 4, baseline, [file()]));
  assert.throws(() => assertDocumentSnapshot(lease(), "other-worker", 4, baseline, [file()]), /租约/);
  assert.throws(() => assertDocumentSnapshot({ ...lease(), leaseUntil: new Date(0) }, "worker-one", 4, baseline, [file()]), /租约/);
  assert.throws(() => assertDocumentSnapshot({ ...lease(), contextVersion: 5 }, "worker-one", 4, baseline, [file()]), /资料或文档已变化/);
  assert.throws(() => assertDocumentSnapshot(lease(), "worker-one", 4, baseline, [{ ...file(), version: 2, content: "human edit" }]), /未覆盖/);
  assert.throws(() => assertDocumentSnapshot(lease(), "worker-one", 4, [], [file()]), /未覆盖/);
  assert.throws(() => assertDocumentSnapshot(lease(), "worker-one", 4, baseline, [{ ...file(), lockedBy: "alice" }]), /编辑状态/);
  assert.throws(() => assertDocumentSnapshot(lease(), "worker-one", 4, baseline, [{ ...file(), userContent: "my edit" }]), /未覆盖/);
  const customFile = { ...file(), filename: "API_DESIGN.md" };
  assert.throws(() => assertDocumentSnapshot(lease(), "worker-one", 4, [customFile], [{ ...customFile, version: 2 }], ["API_DESIGN.md"]), /未覆盖/);
  assert.doesNotThrow(() => assertDocumentSnapshot(lease(), "worker-one", 4, [customFile], [{ ...customFile, version: 2 }], ["NEW_DESIGN.md"]));
});

test("the document job atomically saves real WorkspaceFiles and file events, and rolls both back if the second save fails", async () => {
  const previousRag = process.env.RAG_ENABLED;
  process.env.RAG_ENABLED = "false";
  try {
    for (const dynamic of [false, true]) for (const failSecond of [false, true]) {
      const retained = { ...file(), filename: "USER_NOTES.md", updatedBy: "user", userContent: "Keep my notes" };
      let state = { pkg: { ...lease(), projectId: "project-one", pendingMessage: null, eventSequence: 0 }, files: [retained] as { filename: string; content: string; version: number; updatedBy: string }[], events: [] as { type: string }[] };
      let transactions = 0;
      const database = { async $transaction(callback: (tx: unknown) => Promise<void>) {
        transactions++;
        const snapshot = structuredClone(state);
        const tx = {
          $queryRaw: async () => [],
          researchPackage: {
            findUniqueOrThrow: async () => ({ ...state.pkg, files: structuredClone(state.files) }),
            update: async ({ data }: { data: Record<string, unknown> }) => {
              for (const [key, value] of Object.entries(data)) {
                if (value && typeof value === "object" && "increment" in value) (state.pkg as Record<string, unknown>)[key] = Number((state.pkg as Record<string, unknown>)[key] ?? 0) + Number(value.increment);
                else (state.pkg as Record<string, unknown>)[key] = value;
              }
              return state.pkg;
            },
          },
          projectMember: { findUnique: async () => ({ userId: "user-one" }) },
          clarification: { count: async () => 0 },
          workspaceFile: { create: async ({ data }: { data: { filename: string; content: string; updatedBy: string } }) => {
            if (failSecond && data.filename === "TASKS.md") throw new Error("simulated disk/database write failure");
            const created = { ...data, version: 1 };
            state.files.push(created);
            return created;
          } },
          researchEvent: { create: async ({ data }: { data: { type: string } }) => { state.events.push(data); return data; } },
        };
        try { await callback(tx); } catch (error) { state = snapshot; throw error; }
      } } as unknown as Pick<typeof db, "$transaction">;
      const documents = dynamic ? planDocumentsFromOutput({ documents: selectedDocuments.map(document => ({ filename: document.filename, content: output.plan })) }, selectedDocuments) : planDocumentsFromOutput(output);
      const saving = saveGeneratedPlanDocuments("package-one", "worker-one", "user-one", 4, [retained], documents, database);
      if (failSecond) {
        await assert.rejects(saving, /simulated/);
        assert.deepEqual(state.files, [retained]);
        assert.deepEqual(state.events, []);
        assert.equal(state.pkg.status, DOCUMENTS_DRAFTING);
      } else {
        await saving;
        assert.deepEqual(state.files.map(document => document.filename), [retained.filename, ...documents.map(document => document.filename)]);
        assert.equal(state.pkg.status, "documents_ready");
        assert.equal(state.pkg.contextVersion, 5);
        assert.deepEqual(state.events.map(event => event.type), [...documents.map(() => "file_created"), "documents_completed", "assistant_message", "turn_completed"]);
        assert.equal(state.events.some(event => event.type === "research_completed"), false);
      }
      assert.equal(transactions, 1);
    }
  } finally {
    if (previousRag === undefined) delete process.env.RAG_ENABLED;
    else process.env.RAG_ENABLED = previousRag;
  }
});

test("saving or unlocking draft skills preserves document mode without queuing an agent, while research edits still resume", async () => {
  const previousRag = process.env.RAG_ENABLED;
  process.env.RAG_ENABLED = "false";
  try {
    for (const operation of ["save", "unlock"] as const) for (const hasResearch of [false, true]) for (const initialStatus of ["documents_plan_ready", "documents_ready", DOCUMENTS_DRAFTING, "documents_failed", ...(hasResearch ? ["waiting_for_edit"] : [])]) {
      const initialTaskState = initialStatus === DOCUMENTS_DRAFTING ? "running" : "idle";
      const shouldResume = hasResearch && initialStatus === "waiting_for_edit";
      const pkg = { status: initialStatus, researchPlan: hasResearch ? "{}" : null, taskState: initialTaskState, pendingMessage: null as string | null, eventSequence: 0, contextVersion: 4, leaseUntil: null };
      const document = { ...file(), id: "file-one", lockedBy: operation === "unlock" ? "user-one" : null, lockToken: "0f7db5ac-e2b0-4b12-b6b1-d29b93cb7e41", lockExpiresAt: new Date(Date.now() + 60_000) };
      const tx = {
        workspaceFile: { findUnique: async () => document, count: async () => 0, updateMany: async () => ({ count: 1 }) },
        clarification: { count: async () => 0 },
        researchPackage: { findUniqueOrThrow: async () => pkg, update: async ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && "increment" in value) (pkg as Record<string, unknown>)[key] = Number((pkg as Record<string, unknown>)[key] ?? 0) + Number(value.increment);
            else (pkg as Record<string, unknown>)[key] = value;
          }
          return pkg;
        } },
        researchEvent: { create: async () => ({}) },
      };
      const database = { $transaction: (async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)) as typeof db.$transaction };
      if (operation === "save") await saveUserFile("package-one", "PLAN.md", { baseVersion: 1, content: "# My updated plan" }, "user-one", database);
      else await updateFileLock("package-one", "PLAN.md", { action: "unlock", lockToken: document.lockToken }, "user-one", database);
      assert.equal(pkg.status, shouldResume ? "researching" : initialStatus);
      assert.equal(pkg.taskState, shouldResume ? "queued" : initialTaskState);
      assert.equal(Boolean(pkg.pendingMessage), shouldResume);
    }
  } finally {
    if (previousRag === undefined) delete process.env.RAG_ENABLED;
    else process.env.RAG_ENABLED = previousRag;
  }
});

test("execution and resume cannot bypass active document generation, research work, blockers, or editor locks", () => {
  const pkg = { status: "documents_ready", taskState: "idle", pendingMessage: null as string | null };
  assert.doesNotThrow(() => assertExecutionResearchReady(pkg, 0, 0));
  assert.throws(() => assertExecutionResearchReady({ ...pkg, status: DOCUMENTS_DRAFTING }, 0, 0), /方案文档正在生成/);
  assert.throws(() => assertExecutionResearchReady({ ...pkg, taskState: "queued" }, 0, 0), /待处理任务/);
  assert.throws(() => assertExecutionResearchReady({ ...pkg, taskState: "running" }, 0, 0), /待处理任务/);
  assert.throws(() => assertExecutionResearchReady({ ...pkg, pendingMessage: "未消费的请求" }, 0, 0), /待处理任务/);
  for (const status of ["waiting_for_user", "blocked", "waiting_for_edit"]) assert.throws(() => assertExecutionResearchReady({ ...pkg, status }, 0, 0), /阻塞问题/);
  assert.throws(() => assertExecutionResearchReady(pkg, 0, 1), /阻塞问题/);
  assert.throws(() => assertExecutionResearchReady(pkg, 1, 0), /文档正在编辑/);
});

test("answers to older optional questions are saved without silently resuming a document workflow", async () => {
  const previousRag = process.env.RAG_ENABLED;
  process.env.RAG_ENABLED = "false";
  try {
    for (const status of ["documents_plan_ready", DOCUMENTS_DRAFTING, "documents_ready", "documents_failed", "completed"]) {
      const taskState = status === DOCUMENTS_DRAFTING ? "running" : "idle";
      const pkg = { status, taskState, pendingMessage: null as string | null, eventSequence: 0, contextVersion: 4, leaseUntil: new Date(Date.now() + 60_000), researchPlan: "{}" };
      const question = { id: "question-one", type: "text", priority: "optional", status: "waiting", options: null, answer: null as string | null };
      const events: string[] = [];
      const tx = {
        clarification: {
          findFirst: async () => question, count: async () => 0,
          update: async ({ data }: { data: { answer: string; status: string } }) => Object.assign(question, data),
        },
        researchPackage: {
          findUniqueOrThrow: async () => pkg,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            for (const [key, value] of Object.entries(data)) {
              if (value && typeof value === "object" && "increment" in value) (pkg as Record<string, unknown>)[key] = Number((pkg as Record<string, unknown>)[key] ?? 0) + Number(value.increment);
              else (pkg as Record<string, unknown>)[key] = value;
            }
            return pkg;
          },
        },
        researchEvent: { create: async ({ data }: { data: { type: string } }) => { events.push(data.type); return data; } },
      };
      const database = { $transaction: (async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)) as typeof db.$transaction };
      await answerQuestion("package-one", "question-one", "使用 Node 内置测试", database);
      assert.equal(question.status, "answered");
      assert.equal(question.answer, "使用 Node 内置测试");
      assert.equal(pkg.contextVersion, 5);
      assert.deepEqual(events, ["clarification_answered"]);
      assert.equal(pkg.status, status === "completed" ? "researching" : status);
      assert.equal(pkg.taskState, status === "completed" ? "queued" : taskState);
      assert.equal(Boolean(pkg.pendingMessage), status === "completed");
    }
  } finally {
    if (previousRag === undefined) delete process.env.RAG_ENABLED;
    else process.env.RAG_ENABLED = previousRag;
  }
});
