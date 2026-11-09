# 开发说明

## 账号、项目与访问边界

网页流程是注册／登录 → 我的项目 → 创建项目或凭六位邀请码加入 → 项目研究工作区。`User` 保存账号及 scrypt 密码哈希，`AuthSession` 保存随机会话令牌的哈希和有效期；`Project`、`ProjectMember` 记录项目与成员关系。邀请码由随机大写字母、数字组成，数据库保证唯一，冲突重试；重复加入不产生重复成员。

浏览器研究接口先检查登录，再检查研究包的 `projectId` 及成员关系，覆盖消息、澄清、文件编辑／下载、ZIP、SSE、来源和知识库。未经授权的用户不能凭研究包链接访问。内部 Agent／MCP 使用原有内部令牌，不改为浏览器会话。`lib/sessions.ts` 中的 `DatabaseSession` 仍是 Agent 对话历史，与用户登录会话不同。

会话 Cookie 为 HttpOnly、SameSite=Lax，生产额外使用 Secure 和 `__Host-` 前缀。`SCENARIOFORGE_PUBLIC_ORIGIN` 配置浏览器实际来源：开发例如 `http://localhost:3000`，生产必须为 HTTPS，协议、主机、端口须一致。反向代理的部署和来源头处理见 [Ubuntu 部署说明](../deploy/README.md)。登录和加入邀请码的限流目前只在单个 Node.js 进程内生效，扩展到多个实例前需共享限流。

## MySQL 与历史数据

当前 Prisma datasource 为 MySQL。`DATABASE_URL` 必须是实际 MySQL 连接串，文档、序列化 JSON、会话和向量字段已使用合适的长文本类型。生产通过 `npm run db:generate`、`npm run db:deploy` 应用已提交迁移；开发新增迁移使用 `db:migrate`，不要在生产执行迁移重置或 `db push`。

原 SQLite 迁移保留在 `prisma/sqlite-migrations`，仅用于历史追溯，不能直接部署到 MySQL。已有 SQLite 数据需要备份、显式导入并确认项目及成员归属；`ResearchPackage.projectId` 为空的旧研究包不会自动公开。切换存储不改变研究引擎或应用内余弦检索算法。

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

任务保存在 `ResearchPackage.taskState`、`pendingMessage` 和租约字段中。常驻进程通过 `instrumentation.ts` 启动三秒一次的调度，使用条件更新认领任务，并定期续租。进程退出后，过期租约可以重新认领；已有计划、证据、会话及文件保持持久化。外部 API 已发出的请求不保证恰好执行一次。

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
