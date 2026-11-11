# 开发说明

本文对应 2026-11-11 源码。新增执行 Agent、本地 Runner、文档清单确认及双页签功能，概览见[本版说明](RELEASE_NOTES_20261111.md)。本次源码更新不包含服务器部署；最近的在线部署记录仍为 2026-11-09。新开发者从仓库克隆源码，使用自己的独立 MySQL 与被忽略的 `.env.local`，不依赖原开发机的运行数据、密钥或 `.tmp/`。

## 账号、项目与访问边界

网页流程是注册／登录 → 我的项目 → 创建项目或凭六位邀请码加入 → 项目研究工作区。`User` 保存账号及 scrypt 密码哈希，`AuthSession` 保存随机会话令牌的哈希和有效期；`Project`、`ProjectMember` 记录项目与成员关系。邀请码由随机大写字母、数字组成，数据库保证唯一，冲突重试；重复加入不产生重复成员。

浏览器研究接口先检查登录，再检查研究包的 `projectId` 及成员关系，覆盖消息、澄清、文件编辑／下载、ZIP、SSE、来源和知识库。未经授权的用户不能凭研究包链接访问。内部 Agent／MCP 使用原有内部令牌，不改为浏览器会话。`lib/sessions.ts` 中的 `DatabaseSession` 仍是 Agent 对话历史，与用户登录会话不同。

会话 Cookie 为 HttpOnly、SameSite=Lax，生产额外使用 Secure 和 `__Host-` 前缀。`SCENARIOFORGE_PUBLIC_ORIGIN` 配置浏览器实际来源：开发例如 `http://localhost:3000`，生产必须为 HTTPS，协议、主机、端口须一致。反向代理的部署和来源头处理见 [Ubuntu 部署说明](../deploy/README.md)。登录和加入邀请码的限流目前只在单个 Node.js 进程内生效，扩展到多个实例前需共享限流。

## MySQL 与历史数据

当前 Prisma datasource 为 MySQL。`DATABASE_URL` 必须是实际 MySQL 连接串，文档、序列化 JSON、会话和向量字段已使用合适的长文本类型。生产通过 `npm run db:generate`、`npm run db:deploy` 应用已提交迁移；开发新增迁移使用 `db:migrate`，不要在生产执行迁移重置或 `db push`。

本仓库当前有 14 条 MySQL 迁移；相较 2026-11-09 源码，本版新增 `20261110090000_workspace_execution`、`20261110170000_local_runner`、`20261111120000_local_runner_directory`。它们已在独立测试库验证，但尚未应用到线上生产库；部署前备份并核对目标库全部待执行迁移，不将开发库当测试库或生产库。动态文档清单和双页签本身不增加迁移。

原 SQLite 迁移保留在 `prisma/sqlite-migrations`，仅用于历史追溯，不能直接部署到 MySQL。已有 SQLite 数据需要备份、显式导入并确认项目及成员归属；`ResearchPackage.projectId` 为空的旧研究包不会自动公开。切换存储不改变研究引擎或应用内余弦检索算法。

本地目录展示需迁移 `20261111120000_local_runner_directory`：`LocalRunner.workspaceDirectory` 保存认证 Runner 上报的真实绝对目录，`WorkspaceExecution.workspaceDirectory` 固定任务创建时的目录，两列均可空。路径只作本人展示，不用于服务端文件访问或模型输入；同连接不允许更换目录。`visibleResearchEvents` 依据数据库中的任务归属，在研究快照/SSE只允许发起者查看本地执行事件；`getContext` 未指定浏览用户时排除本地执行事件，防止相对路径和命令详情进入共享研究模型上下文。SSE 即使跳过不可见事件也推进游标。

## Agent 如何调用 MCP

项目创建者在网页的“模型 API 设置”中保存 HTTPS 基础地址、API Key、模型 ID、API 协议和超时。成员只读元信息，接口不回传真实 Key 或其后缀；Key 留空时保留已保存值。保存与连接测试相互独立，测试可能产生少量模型调用费用。

`SCENARIOFORGE_SETTINGS_KEY` 是服务端专用的 32 字节随机 AES 密钥，使用 base64 编码。`lib/model-settings.ts` 用 AES-256-GCM 加密配置，并将项目 ID 作为附加认证数据。密钥不进入网页、数据库记录或 `NEXT_PUBLIC_` 环境变量；须与数据库备份分开私密保管。没有自动轮换工具，更换前必须设计存量项目配置及执行快照的重加密迁移，不能直接替换环境变量。

`lib/agent.ts` 使用 OpenAI Agents SDK 的 `Agent`、`Runner` 和 `MCPServerStreamableHttp`。MCP 通过 `mcpServers` 传入 Agent；模型按工具 Schema 产生调用，SDK 在服务端通过 HTTP 执行。每次调用都会强制绑定当前研究包 ID，避免模型将结果写入其他研究包。

`lib/openai.ts` 用同一 `OpenAIProvider` 按配置选择 Responses 或 Chat Completions。研究每轮开始时保存当前项目配置的加密快照，Node 与 Python 使用该轮配置；用户在执行中修改或删除项目配置不会切换进行中的轮次。新轮次取最新项目配置；未配置或已清除项目配置时，回到管理员配置的服务器默认值。默认值也缺失则明确报告配置不足。关闭 SDK tracing，避免向额外服务发送用户资料。API Key 只在 Next.js 和 Python 服务端使用。

数据库保存 `sessionId` 及 SDK 会话条目。`DatabaseSession` 实现 SDK Session 接口，支持在澄清、保存文件和后续对话时继续相同会话。Agent 每个模型回合都会读取最新澄清答案和文件版本；恢复时通过 MCP 重新读取用户编辑过的文件。

## 模型调用位置

Python `llm.py` 统一处理模型请求、Schema 校验和一次无效 JSON 修正。研究规划、1–3 个搜索查询生成、证据整理、证据综合和按计划生成 Markdown 都使用这个入口。Node.js Agent 使用同一环境变量指定的模型负责规划调用顺序、提出澄清问题、理解用户新输入并总结。

Chat Completions 模式使用带 JSON Schema 的强制函数调用，兼容仅提供 tool calling 的中转站；Responses 使用 JSON Schema 输出。两种模式都在本地验证数据类型与数量，不把任意字符串当作可信对象保存。

## 持久化与任务

Prisma 是唯一的数据库写入入口。Python 的 `backend.py` 调用受 `SCENARIOFORGE_INTERNAL_TOKEN` 保护的内部 Route Handler。成员可访问的研究快照不返回上传全文、会话条目、内部凭据或编辑锁 Token。

任务保存在 `ResearchPackage.taskState`、`pendingMessage` 和租约字段中。常驻进程通过 `instrumentation.ts` 启动三秒一次的调度，使用条件更新认领任务，并定期续租。普通研究进程退出后，过期租约可以重新认领；已有计划、证据、会话及文件保持持久化。外部 API 已发出的请求不保证恰好执行一次。

网页首次输入和已有对话的「本次操作」均默认「生成方案」，只有显式切换「仅讨论」才走聊天／按要求联网研究。当前方案入口采用「预览文档清单」→ 编辑清单 →「确认并生成 N 份文档」，右侧空态按钮为「根据当前需求规划文档」。清单与实际文件分开展示，清单不创建 `WorkspaceFile`，不进入技能选择；已保存文件仍可浏览和交接。

### 方案文档预览与确认 API

首次创建 `POST /api/research` 时传 `mode: "documents"`，只创建本地推荐清单并进入 `status=documents_plan_ready`、`taskState=idle`，不排入 Worker、不调用模型；省略 `mode` 的旧 API 请求仍按 `"chat"` 处理。`lib/document-proposal.ts` 共享清单 Schema、模板及本地推荐函数：默认 `PLAN.md` / `TASKS.md`，按需求中明确的架构、接口、数据库、实验、风险、测试策略、里程碑等关键词或模板文件名推荐更多。它不是 AI 语义规划，不联网，也不验证推荐是否充分；用户可编辑后确认。

已有研究包使用 `POST /api/research/:id/documents`，两种请求如下：

```json
{ "action": "preview", "request": "设计数据库和接口" }
```

`request` 可省略或留空，使用原目标；省略 `action` 兼容为 `"preview"`。成功返回 HTTP 200 的 `{ "proposal": { "id": "…", "request": "…", "contextVersion": 1, "documents": [{ "filename": "PLAN.md", "purpose": "实现方案与边界", "contentOutline": ["目标与交付物", "实施步骤与验收方式"] }] } }`。预览经 `documents_plan_proposed` 事件持久化提案及目标文件基线，不增加数据库表或迁移，也不调用项目模型。GET `/api/research/:id` 返回 `documentProposal`（无提案时为 `null`）及 `documentProposalStale`；已过期的提案仍返回，前端保留编辑输入、禁止确认，必须显式重新预览后替换。

```json
{
  "action": "generate",
  "proposalId": "上次预览返回的提案 ID",
  "documents": [
    { "filename": "PLAN.md", "purpose": "实现方案与边界", "contentOutline": ["目标与交付物", "实施步骤与验收方式"] }
  ]
}
```

`documents` 为用户最终确认的 1–20 项，可增删模板或使用自定义文档。文件名匹配 `^[A-Za-z][A-Za-z0-9_-]{0,79}\.md$`，禁止目录、系统保留名及忽略大小写后的重名；用途 1–1000 字符，内容要点 1–12 条且每条 1–500 字符，整份清单序列化后至多 32,000 字符。非法请求不排队；过期提案、上下文或目标基线冲突返回 409，前端保留输入。确认成功返回 HTTP 202 并进入 `status=drafting_documents`、任务队列；Worker 调用 `lib/plan-documents.ts`，仅发一次结构化模型请求，无工具、搜索或自动重试。模型必须返回与确认文件名一致的 `{documents:[{filename,content}]}`；成功保存后进入 `documents_ready`，失败进入 `documents_failed`。运行租约过期时明确失败，必须由用户决定是否再次生成，避免重启后重复收费。

预览、确认及保存事务检查项目成员权限、任务互斥、阻塞澄清和编辑锁；确认校验最新提案 ID、上下文版本和文件基线，保存还检查租约、上下文版本和文件版本。用户已编辑的任意所选目标不能由生成器覆盖，未选中的旧文件保留；改名或移除目标后可重新确认。编辑方案、回答已有可选问题只保存更新，不隐式启动研究；普通研究状态仍沿用原有续跑逻辑。取消或修改清单不会自动调用模型，页面「暂不生成」仅收起清单，刷新可恢复持久化提案。

预览后继续提交普通用户讨论时，在排队的同一事务递增上下文版本，使旧清单过期；普通回复不抹掉旧清单。澄清问题超时产生默认答案或跳过状态时也递增版本，重复超时处理不会再次递增；生成中的任务因此不能保存基于旧答案的正文。这些更新不会自动重新生成文档。

前端订阅 `documents_plan_proposed`、`documents_requested/started/completed/failed` 和文件事件刷新快照，交接按钮只带入执行要求并选择当前包已保存技能，用户确认后才创建执行任务。执行日志按 `executionId` 显示在各自任务卡，研究进度排除 `execution_*`。离线回归入口为 `npm run check:plan-documents`，联合验收入口为 `SCENARIOFORGE_LOCAL_JOINT_PLAN=1` 下的 `check:local-runner-joint`，必须使用独立测试库。本次清单功能的验证范围见[最新验收追记](PLAN_WORKFLOW_VALIDATION_20261111.md)，以下调度器与既有联合验收结果保留为此前记录。

当前项目工作区用 `WorkspaceNavigation` 提供「方案与文档」和「执行工作区」页签，两个 `role=tabpanel` 均保持挂载，仅通过 `hidden` 切换展示，避免丢失编辑器草稿/锁续期、执行要求、技能和 Runner 选择及差异查看状态。导航固定显示项目、当前工作方式与连接摘要，本地模式展示目录与 Runner 状态；执行页签标出活动任务和本人待审批命令。`AgentWorkspace` 通过连接变化回调更新摘要，后台轮询仍运行，但只有活动执行页签才进行交接后的聚焦滚动；隐藏方案中的新提案也不抢占滚动。

页签切换只用 `replaceState` 更新 `workspace=execution`，不会发起任务。项目/研究切换清除此参数，文档 `file` 查询与研究/澄清/证据哈希深链优先打开方案。`useActionTarget` 通过 `aria-labelledby` / `aria-controls` 找到隐藏目标面板的页签，只触发一次选择，观察 `hidden` 变化后展开目标的 `<details>` 并聚焦，支持异步挂载。项目 `PersonalAgent` 收件箱默认收起，个人中心的模型设置仍默认展开。当前/活动执行保留展开，其他已结束执行置于默认折叠的历史区；审批与恢复权限沿用原逻辑。

方案页签内桌面研究区域的两列等高、内容各自滚动，对话输入区固定在面板底部；移动端改为竖排。配对和运行说明位于执行页签的「连接与运行设置」折叠区。当前双页签功能的测试与截图范围见[验收报告最新追记](PLAN_WORKFLOW_VALIDATION_20261111.md)，下面的旧调度器与布局验收数字保留为历史记录。

本次实际排查到旧 Next dev 进程的全局 interval 保留了旧 `tickTasks` 闭包：新 API 已写入 `documents_requested`，旧 Worker 却发出 `turn_started` 并走 ProjectAgent。`lib/task-scheduler.ts` 现将当前 tick 放在共享进程状态，并按版本替换旧 interval；`lib/tasks.ts` 热加载时升级已有调度器，不重置运行中排他标记、不取消活动任务。确认无 queued/running 任务后已重启本地网页服务。`npm run check:task-scheduler` 的 2 项纯离线测试覆盖旧回调替换、后续热更新和进行中任务保留；10 项方案离线测试、最终生产构建、lint、类型检查通过。默认提交和布局调整后的浏览器补验 26/26 通过（方案 6、对话 9、执行区 11）；最终构建的独立数据库、真实网页与 Runner 联合补验也已通过，模型为本机 HTTP 夹具，详情见[专项追记报告](PLAN_WORKFLOW_VALIDATION_20261111.md)。此前 21 项浏览器结果保留为历史记录。

团队/个人 Agent、成本审查和代码任务分支的目标边界及实施阶段见 [Agent 协作计划](AGENT_ORCHESTRATION_PLAN.md)。只有当前研究包使用已配置的项目模型时，顶层 Agent 才获得 `delegate_tasks` 工具；一批最多两个独立文本任务，由同一项目模型并行执行，每个子 Agent 最多一个模型回合和 2,048 输出 token，不提供搜索、MCP、文件写入或外部工具。顶层模型收到结果后必须审核整合。

`AgentSubtask` 以研究包和活动租约 ID 关联，保存明确目标、显式上下文、结果、状态及实际 token 用量；`ResearchPackage.agentTaskCount` 在活动租约内原子递增，阻止重试或并发超过两个任务。研究进度事件显示任务目标和状态，不包含上下文正文。迁移 `prisma/migrations/20261107120000_team_agent_subtasks/` 已在用户授权后应用到生产，团队 Agent 现已部署。此次有离线测试和生产构建，但没有独立 MySQL 集成测试或真实模型派发测试；成员隔离、失败记录与租约恢复仍需在隔离测试库验收。

## SSE 如何推送进度

搜索由 `lib/search/index.ts` 的工厂统一选择 Provider。Python `search_scenario` 先通过内部 `begin_search` 占用一次研究问题搜索额度，再通过 `search` 执行 1–3 个查询；额度仍按工具调用计数，不按改写后的查询数重复扣除。每个问题的合并去重结果受 MAX_SEARCH_RESULTS_PER_QUESTION 限制。

所有适配器输出 SearchResult；模型只接收规范化来源，不接收厂商原始响应。query、provider、fetchedAt 保存在搜索结果事件中。`search_evidence` 校验证据来源与真实返回结果一致，并在事务中保存证据及 `search_completed`。新搜索只有完成证据保存后才被生成校验认可；历史仅含 `search_started` 的研究包仍兼容。搜索失败不会自动切换服务，也不会回退到假数据。

DDGS 经同端口的鉴权 HTTP endpoint 调用 Python 库，内外两端均有超时。同步库放在线程中执行以避免阻塞 MCP 事件循环，库自身同样设置网络超时；应用层取消等待后，底层线程会随库的超时结束。

研究包维护递增事件序号。状态或文件修改和相应事件在 Prisma 事务中写入。SSE 接口按序号轮询持久化事件，发送标准 `id`、`event` 和 JSON `data`；浏览器使用 `EventSource` 订阅，再读取研究包快照更新界面。

首次订阅带快照末尾的 `after` 参数；断线重连优先使用 `Last-Event-ID`，补发遗漏事件。定期心跳、请求取消和连接回收都在服务端处理。浏览器提示正在重连，并通过包 ID 在刷新后恢复工作区。

## 澄清与超时

`ask_user` 保存一组问题；阻塞问题将研究包置为 `waiting_for_user`。工具执行后，SDK 的 `toolUseBehavior` 检查数据库并结束当前执行轮次，释放长时间等待的运行资源。

回答 API 校验文本和选项，更新上下文版本，所有阻塞问题解决后排入继续执行任务。调度器同时处理超时：安全默认值标记 `timeout_default`，无默认值的阻塞问题保留为 `blocked`，可选问题可跳过。迟到的用户回答可以恢复研究或修正默认假设。

## 编辑如何与 Agent 协调

文件接口 `PATCH` 管理编辑锁与续期，`PUT` 保存用户修改。编辑锁有随机 Token 和 120 秒租约；浏览器每 30 秒续期，关闭或异常断开后锁最终会释放。

所有写入使用 `baseVersion`。Agent 写入遇到锁返回 `locked`，旧版本返回 `conflict`。用户保存后原子增加版本、保存用户原文、解锁、记录事件并更新任务输入。后续 Agent 必须重新读取最新版本；服务端始终检查其新内容保留用户最后保存的全文。整包生成直接保留用户已编辑的文件，Agent 可通过单文件写入追加建议。

项目成员共享工作区，编辑继续使用锁、版本校验及保留用户原文的追加建议机制；尚无实时同屏编辑或自动语义合并。保存冲突不会清除编辑器草稿；未保存草稿仅保存在当前窗口的 sessionStorage。

## 动态文件计划

`ResearchPackage.researchPlan` JSON 中的 `filePlan` 保存文件名称、用途、priority（required/recommended/optional）及 contentOutline。初始计划通过 `planning_completed` 事件公布；公开快照的 `filePlan` 字段供前端展示，无需数据库迁移。

README.md、RESEARCH.md、SOURCES.md 必须存在且为 required。其他主题按目标、约束和证据选择，计划最多 20 项，忽略大小写检查重名。优先级表示重要程度；计划中的所有条目均为选定的交付文件。

研究发现新主题时，Agent 调用 `update_file_plan` 提供文件元数据和追加理由。服务端合并保存计划并发出 `file_plan_updated`，前端同步展示计划及标签页；更新保留原有条目。正文写入必须在公布计划之后，且文件名必须列入当前计划。生成模型的文件集合必须与计划一致，不能遗漏、重复或夹带额外文件。

任务完成检查比较计划与实际文件名，不使用固定数量。历史工作区可继续浏览、编辑和下载；再次研究时补齐计划字段，并保留已有文档。用户原文保护和编辑锁同样适用于新增类型的文件。

## 文件下载

单文件接口返回 `text/markdown; charset=utf-8` 与 attachment 响应头。ZIP 接口使用 JSZip 从数据库构造当前文件快照。两者接受通过安全文件名校验的根目录 Markdown 文件，禁止路径穿越和系统保留名。ZIP 包含当前数据库中实际存在的文件。

## 验证边界

- `check:integration` 验证真实本地 API、Prisma、SSE、下载、文件冲突、用户原文保护和澄清超时，结束后清理自己的临时研究包。
- `check:project-access` 验证账号注册／登录／退出、邀请码加入、成员共享、非成员拒绝及会话保护，清理自己创建的账号、项目和研究包。
- `check:browser` 使用真实浏览器验证页面预览、实时更新、下载、上传边界、澄清回答和编辑保存。
- `check:search` 使用 Node 测试运行器验证工厂及四种 Provider，HTTP 服务使用拦截响应，不访问外部网络。
- `check:ddgs` 通过真实 FastMCP ASGI 路由验证 DDGS endpoint，库调用使用测试替身。
- `check:agent` 使用真实 SDK、MCP HTTP、数据库、任务调度与 API；模型回答使用本地夹具，搜索调用正式 Mock Provider，验证两种 API 模式的完整状态流程。
- 真实供应商连接、模型可用性、搜索返回质量和文档研究质量，需要使用真实凭据另行验收。

`check:agent`、`check:rag` 和 `check:rag-agent` 使用 `SCENARIOFORGE_TEST_DATABASE_URL` 指定独立 MySQL 测试库，名称须以 `scenarioforge_test_` 开头，不能使用应用数据库。Agent 夹具仍使用独立构建目录与本机模型／搜索端点。

`check:db-integration` 还要求 `DATABASE_URL` 与该测试 URL 完全相同，检查真实 MySQL 上的成员权限、项目资料分享/复用/归档和团队子任务租约恢复。测试数据按本次创建的 ID 清理。服务器运行 Node 前须将项目 Node 运行时加入 `PATH`；dotenv 通过 `node --env-file=私有测试文件` 加载，不直接当作 shell 脚本。Agent E2E 支持 `AGENT_E2E_PORT=3010` 避开生产 3000，测试 Web 只监听回环且使用 webpack；8001 和 9009 也需空闲。2026-11-08 的临时测试库已删除，重跑前需重新建立专用库与最小权限测试账号。

## RAG

RAG 位于 `lib/rag/`，默认关闭。启用前需提供独立 Embedding 的地址、凭据和模型；本轮没有配置或验收真实模型、搜索与 Embedding。成员权限按团队项目检查，检索仍按研究包隔离。配置、回填、MCP／CLI 及测试说明见 [RAG.md](RAG.md)，历史验收记录见 [VALIDATION.md](VALIDATION.md)。
