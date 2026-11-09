# ScenarioForge 交付与接续说明

交付日期：2026-11-08（Asia/Shanghai）。本文件说明当前生产版本；其他文档中带日期的记录是历史过程，不能将旧的“待实现”或测试结果当作当前状态。

## 1. 项目是什么

ScenarioForge 是团队项目与 AI 协作网页：团队 Agent 处理对话、研究和成员任务派发；成员使用独立的个人模型进行私有讨论，确认后提交结果，由组长审查并保存到 Git。当前完成的是研究及 Markdown 文档交付闭环，尚不是可自动修改和运行任意代码的开发环境。

- 生产网页：https://175.27.143.14/
- 现有项目：申威课设。创建者 nayun，已配置个人 Agent 的测试成员 user1。组长也有个人空间，配置自己的模型并开启接收后可接收任务。
- 交付演示仓库：https://github.com/nayun118/ScenarioForge
- 已核验 main：0fdda327e0f0aaa259dab5a573fd3739ce9c8ebe。远程仓库包含项目 README 和测试交付文档；网站完整源码在本交付包的 source 目录中。
- 生产发布：git-sync-20261108T093232Z。交接整理没有修改业务代码、增加迁移、付费服务或真实模型调用。

## 2. 功能与验收边界

| 方向 | 当前可用内容 | 限制与后续 |
| --- | --- | --- |
| 真实 AI 研究 | 项目加密保存模型配置；真实 DeepSeek 对话、拆题、澄清恢复、文档生成已验证。一般聊天不强制研究；研究问题按需要为 1–6 个。 | 真实文档测试曾使用 Mock 来源；篇幅遵循、完整真实来源与引用质量尚未全面验收。不能把完成状态等同于内容正确。 |
| 联网搜索 | DeepSeek Search 仅在申威课设按授权启用，一次真实查询通过；全局仍为 mock。 | 暂不扩展通用搜索服务，不调用 Fetch。其他项目默认不启用；Mock 结果不能充当真实依据。新增费用和服务先征询用户。 |
| RAG / Embedding | 分块、向量检索、索引、引用等代码保留。 | 生产 RAG_ENABLED=false，未接入 Embedding，按用户要求暂缓。不能宣称语义检索已经生效。 |
| 团队共享知识 | 同项目显式分享证据、关键词查找、归档/恢复，新研究可选择最多 3 条共享资料。权限和隔离 MySQL 测试通过，拒绝 Mock 证据入共享库。 | 当前为关键词匹配，不依赖 Embedding；不是语义检索。 |
| 个人与团队 Agent | 组长和成员均有个人空间。团队派发、个人私有初稿、追问/编辑、明确提交、顶层审核已上线；用户确认交互交付成功。 | 每个个人任务含初稿最多 6 次模型尝试，每次最多 2,048 输出 token；提交才向团队共享，私有讨论不共享。 |
| Git 文档交付 | 每任务独立分支/工作区，差异查看、组长确认合并、部署公钥、远程检查和确认推送已上线，并完成生产网页真实推送。 | 暂无通用非空/私有仓库导入、拉取/冲突编辑、源代码修改与执行、自动测试或 PR 流程。Git 操作本身不调用模型。 |
| 远程 MCP | 当前仅服务器内部 MCP，供网页研究工具调用。 | 本阶段暂缓。网页内个人模型与任务流程已经覆盖当前协作需求；将来接入成员自己的 IDE/外部 Agent 时再开发认证、项目授权和审计。 |

## 3. 使用闭环

1. 用户注册/登录并创建项目，或凭邀请码加入。项目创建者配置团队模型；保存和测试连接是独立操作。
2. 成员在个人 Agent 面板配置自己的模型并开启接收。个人凭据按用户和项目隔离，组长不能读取成员的 Key 或私有讨论。
3. 团队 Agent 直接回答简单任务；确有协作价值时派发最多两个任务，并提供必要上下文。
4. 成员阅读初稿，与个人 Agent 讨论或手动修改，确认后提交。提交会排队顶层审核，模型调用仍会计费用。
5. 将本人已确认交付保存到任务分支。组长查看差异并确认合并本地 main，再检查 GitHub、预览并确认推送。

任务 SHENWEI-INTERACT-1108B 是功能测试，不代表真实课设需求。GitHub 原有初始化历史和测试交付均已保留，没有强推覆盖。

## 4. 技术结构和源码入口

| 位置 | 内容 |
| --- | --- |
| app / hooks | Next.js 页面、React 组件、鉴权和项目/研究/个人任务/Git API |
| lib/project-agent.ts、team-agent.ts、personal-agent.ts | 顶层规划、成员派发、个人任务讨论与提交 |
| lib/model-settings.ts、model-endpoint.ts、model-test.ts | 模型配置加密、公网端点限制及连接检查 |
| lib/repository.ts | 隔离 Git 工作区、审查合并和 GitHub 同步 |
| lib/search、lib/rag | 搜索 Provider 与未启用的 RAG 基础能力 |
| mcp-server | Python FastMCP 研究工具，仅回环监听 |
| prisma | MySQL schema 和 6 条现行迁移；sqlite-migrations 仅为历史留存 |
| scripts / tests | 单元、隔离数据库、完整 Agent 夹具与 Playwright 验证 |
| deploy | 自托管部署、服务安装、nginx、证书续期与配置模板 |
| docs/VALIDATION.md、docs/AGENT_ORCHESTRATION_PLAN.md | 按日期验收记录和协作设计边界 |
| docs/evidence | 归档验收截图；涉及邀请码的页头已遮盖，夹具截图不代表真实供应商调用 |

依赖通过 package-lock.json 和 mcp-server/uv.lock 锁定。要求 Node >=22.12、Python >=3.11；现有服务器运行 Node v24.22.2、Python 3.11.18。数据库为 MySQL，不要照旧 SQLite 记录操作。

## 5. 接续开发

先阅读 AGENTS.md；修改 Next.js 前查当前安装版本 node_modules/next/dist/docs/。本机源码目录是 D:\5\ScenarioForge-main，目前没有 .git。GitHub 中的交付演示仓库与网站源码目录是两件不同的资源。

在新的开发目录安装并准备独立数据库：

```sh
npm ci
# 由 .env.example 创建 .env.local，填写独立开发数据库及随机内部令牌、配置加密密钥。
npm run db:generate
npm run db:deploy
npm run dev -- --hostname 127.0.0.1
```

在第二个终端进入 mcp-server 后执行 uv sync --locked、uv run main.py。uv 需预先安装。浏览器来源必须与 SCENARIOFORGE_PUBLIC_ORIGIN 一致。测试模型和搜索保持夹具/Mock，只有需要真实调用且获授权时才配置真实服务。

现有本机 .env.local 连接生产数据库，不可直接用于开发迁移或测试夹具。严禁对它执行 reset、db push、migrate dev 或全表清理。check-db-integration.ts 需要 DATABASE_URL 与 SCENARIOFORGE_TEST_DATABASE_URL 指向同一个 scenarioforge_test_* 独立库。

TypeScript、ESLint 与离线测试入口见 package.json；生产构建必须使用 webpack，并遵循 deploy/README.md 的独立源码目录、资源限制和完整产物切换流程。不要在生产目录原地运行无资源上限的构建。

## 6. 线上运维和备份

- Ubuntu 源码：/home/ubuntu/scenarioforge；Web 127.0.0.1:3000，MCP 127.0.0.1:8000/mcp，MySQL 独立实例 127.0.0.1:3307，数据库 projectdb。
- 常驻服务：scenarioforge-web、scenarioforge-mcp、mysql-isolated；证书续期：scenarioforge-cert-renew.timer。80 端口和续期 timer 必须保持可用。
- 生产配置为 deploy/private/.env.local，根目录 .env.local 指向它；node_modules、Python .venv 和 deploy/private/runtime 是运行依赖，清理时保留。
- 模型凭据在数据库加密保存，恢复数据库必须配合原 SCENARIOFORGE_SETTINGS_KEY。不能用本机配置覆盖生产配置，也不能随意换加密密钥。
- SSH 私钥和数据库连接配置仍保存在用户原受保护位置，不放入源码包；远程 Git 私钥在服务器 deploy/private/repositories/credentials/<projectId>，仅公钥可展示。
- 清理前新建的私有备份目录：/home/ubuntu/scenarioforge/deploy/private/backups/handoff-20261108T095944Z。内含当前源码、数据库压缩转储、Git 仓库、私有配置、前一构建对应源码和 SHA256SUMS。目录 0700、文件 0600，不加入对外交付包。
- 保留前一构建 .next-before-git-sync-20261108T093232Z（BUILD_ID=-1nRrYLITkMQekV6OumTQ），对应备份中的 source-for-previous-build.tar.gz。此前两个 source-before-git-sync 历史包为空，不能用于恢复；本次已经补齐有效快照和回滚对应说明。
- 已检查压缩包可读性与校验值；尚未进行数据库恢复演练或异机重装验证。应用回滚时不能直接用旧数据库覆盖之后产生的用户数据。

```sh
systemctl is-active scenarioforge-web scenarioforge-mcp mysql-isolated
curl --fail http://127.0.0.1:3000/ -o /dev/null
systemctl is-active scenarioforge-cert-renew.timer
```

## 7. 已知限制与后续顺序

1. 正式生产使用前补自动备份、恢复演练及负载边界。当前研究队列最多两项并发，部分限流和 Python 用量额度在单进程内存，重启会清零。
2. Git 操作锁仅适用于单 Web 进程；扩容前改为共享锁。网页不执行仓库代码；若继续开发代码能力，应先设计隔离运行和明确授权，再加差异/测试/交付流程。
3. 真实研究的文档篇幅、来源可靠性和引用质量仍需专门验收；本次整理不额外调用收费模型或搜索。
4. 模型输入 token 没有累计硬上限，尚无项目月度金额预算；拆分和调度不保证总费用下降。
5. RAG/Embedding、通用搜索和远程 MCP 按当前决定暂缓。增加外部服务、模型调用范围或持续运维成本前，先向用户说明费用、数据去向和替代方案。

清理明细、空间回收及交付包校验记录见同目录 CLEANUP.md；完整历史见交付包根目录 handoff.md。
