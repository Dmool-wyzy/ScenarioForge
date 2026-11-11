# ScenarioForge 交付与接续说明

原始交付日期：2026-11-08；源码与最近部署状态更新：2026-11-11（Asia/Shanghai）。执行 Agent、Local Runner、文档清单与双页签已部署，发布代码为 `662e5ed`，线上共 14 条迁移。[最新上线记录](DEPLOYMENT-20261111.md)包含版本、备份和验收范围；[2026-11-09 上线记录](DEPLOYMENT-20261109.md)保留为历史。第 1–6 节包含原始交付资料与后续环境补记；当前状态以[本版更新说明](RELEASE_NOTES_20261111.md)和末尾「服务器部署与验收补记」为准。

当前流程为「方案与文档」预览并确认 1–20 份 Markdown → 保存正文 → 交接至「执行工作区」→ 确认技能、目录和要求 → 手动启动 → 文件修改、验证与审查。最新浏览器组合 42/42、另五项集成用例分次通过，方案离线回归 15/15；本机模型夹具的独立数据库/网页/Runner 联合验收通过，独立 Node 测试 5/5。此次部署另通过 Linux 133/133、独立数据库 19/19、真实 Docker 1/1，以及无模型公网清单预览、Runner HTTPS API 配对/目录/撤销。新入口真实模型 + Docker、线上 Runner CLI 与实际电脑目录配对、GitHub Agent 全流程仍待验收；此次没有线上浏览器布局交互验收。

## 1. 项目是什么

ScenarioForge 是团队项目与 AI 协作网页：团队 Agent 处理对话、研究和成员任务派发；成员使用独立的个人模型进行私有讨论，确认后提交结果，由组长审查并保存到 Git。当前源码另包含把 Markdown 作为技能交给工作区 Agent、修改本地目录或仓库任务分支的执行闭环。执行环境仍限于有界文本文件和现有 Node 容器能力，不能视为任意工程均已支持。

以下项目名、演示仓库、提交及生产路径是原始交付历史，网站完整源码仓库为 [Dmool-wyzy/ScenarioForge](https://github.com/Dmool-wyzy/ScenarioForge)。

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
| RAG / Embedding | 已有可配置的分块、Embedding、向量索引、检索和引用实现。 | 生产 `RAG_ENABLED=false`，真实 Embedding Provider 与检索质量尚未验收；不能宣称生产语义检索已经生效。 |
| 团队共享知识 | 同项目显式分享证据、关键词查找、归档/恢复，新研究可选择最多 3 条共享资料。权限和隔离 MySQL 测试通过，拒绝 Mock 证据入共享库。 | 当前为关键词匹配，不依赖 Embedding；不是语义检索。 |
| 个人与团队 Agent | 组长和成员均有个人空间。团队派发、个人私有初稿、追问/编辑、明确提交、顶层审核已上线；用户确认交互交付成功。 | 每个个人任务含初稿最多 6 次模型尝试，每次最多 2,048 输出 token；提交才向团队共享，私有讨论不共享。 |
| Git 文档交付与工作区 Agent | 通用仓库导入、文件编辑、分支、人工合并与同步已有实现；仓库执行 Agent 和本地 Runner 已于 2026-11-11 部署，支持版本化技能、文件操作、隔离验证及差异。 | GitHub Agent 从真实模型修改到 Docker 验证、人工合并的端到端验收，以及线上 Runner CLI 与实际电脑目录链路仍待完成。Git 文档交付本身不调用模型。 |
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
| prisma | MySQL schema 和 14 条迁移；本版包含执行、Runner、目录快照三条迁移；sqlite-migrations 仅为历史留存 |
| scripts / tests | 单元、隔离数据库、完整 Agent 夹具与 Playwright 验证 |
| deploy | 自托管部署、服务安装、nginx、证书续期与配置模板 |
| docs/VALIDATION.md、docs/AGENT_ORCHESTRATION_PLAN.md | 按日期验收记录和协作设计边界 |
| docs/evidence | 归档验收截图；涉及邀请码的页头已遮盖，夹具截图不代表真实供应商调用 |

依赖通过 package-lock.json 和 mcp-server/uv.lock 锁定。要求 Node >=22.12、Python >=3.11；现有服务器运行 Node v24.22.2、Python 3.11.18。数据库为 MySQL，不要照旧 SQLite 记录操作。

## 5. 接续开发

在新目录克隆 `https://github.com/Dmool-wyzy/ScenarioForge.git` 并进入仓库；GitHub 中的原交付演示仓库与本站完整源码仓库是两件不同的资源。修改 Next.js 前查当前安装版本 `node_modules/next/dist/docs/`，并遵循当前工作区的 Agent 指引。

在新的开发目录安装并准备独立数据库：

```sh
npm ci
# 由 .env.example 创建 .env.local，填写独立开发数据库及随机内部令牌、配置加密密钥。
npm run db:generate
npm run db:deploy
npm run dev -- --hostname 127.0.0.1
```

在第二个终端进入 mcp-server 后执行 uv sync --locked、uv run main.py。uv 需预先安装。浏览器来源必须与 SCENARIOFORGE_PUBLIC_ORIGIN 一致。测试模型和搜索保持夹具/Mock，只有需要真实调用且获授权时才配置真实服务。

原开发机使用独立本机开发库 `scenarioforge_dev`（`127.0.0.1:33317`），数据目录位于 `.tmp/scenarioforge-local-mysql-20261110/data`，与系统 MySQL 服务及服务器生产库隔离；此目录不随源码分发。新开发者应自行创建独立数据库并配置 `.env.local`，不要依赖原机器的数据目录或账户。2026-11-11 最近健康检查为网页 200、原 Runner 在线；实际进程状态需继续开发时重新检查。数据库凭据只保存在被忽略的配置中，不得提交。

Windows 重启后，在仓库根目录 PowerShell 中运行以下命令启动独立实例；保持终端打开，按 `Ctrl+C` 可正常停止。不要在实例已运行时重复启动：

```powershell
$mysqlBase = "C:\Program Files\MySQL\MySQL Server 8.0"
$mysqlRoot = Join-Path (Get-Location) ".tmp\scenarioforge-local-mysql-20261110"
& "$mysqlBase\bin\mysqld.exe" --no-defaults --console `
  "--basedir=$mysqlBase" "--datadir=$mysqlRoot\data" `
  --port=33317 --bind-address=127.0.0.1 --mysqlx=0 --named-pipe=0 `
  "--pid-file=$mysqlRoot\mysql.pid" "--log-error=$mysqlRoot\mysql.log"
```

当前应用和数据库验收均使用 MySQL，不依赖 `prisma/dev.db`。原开发机仍有约 2.90 MiB 的历史 SQLite 文件，被 Git 忽略，不随源码或部署分发；`scripts/check_migration.py` 是读取该文件的历史 SQLite 迁移验证脚本，不是当前 MySQL 验收入口。历史文件未在此次部署中删除；如需处理旧数据，先单独确认其保留或导入范围。数据库集成测试使用 `scenarioforge_test_*` 独立库，设置 `DATABASE_URL` 与 `SCENARIOFORGE_TEST_DATABASE_URL` 指向同一个测试库；不要在开发库或生产库运行测试清理操作。

TypeScript、ESLint 与离线测试入口见 package.json；生产构建必须使用 webpack，并遵循 deploy/README.md 的独立源码目录、资源限制和完整产物切换流程。不要在生产目录原地运行无资源上限的构建。

## 6. 线上运维和备份

- 当前发布：`workspace-agent-20261111-662e5ed`，代码 `662e5ed6bc066245e88314954ded62cb98908aa3`，BUILD_ID `Zwkz6k8STTt7AjaAP6_-b`。北京时间 2026-11-11 13:49:45 完成切换，14 条生产迁移已全部应用，MCP 未重启。
- 当前发布目录：`/home/ubuntu/scenarioforge-release-workspace-agent-20261111-662e5ed`；私有备份：`/home/ubuntu/scenarioforge/deploy/private/backups/workspace-agent-20261111-662e5ed`。上一构建和依赖分别为应用根目录下 `.next-before-workspace-agent-20261111-662e5ed`、`node_modules-before-workspace-agent-20261111-662e5ed`。应用回滚保留现有数据库，不用发布前转储覆盖上线后数据。
- Ubuntu 源码：/home/ubuntu/scenarioforge；Web 127.0.0.1:3000，MCP 127.0.0.1:8000/mcp，MySQL 独立实例 127.0.0.1:3307，数据库 projectdb。
- 常驻服务：scenarioforge-web、scenarioforge-mcp、mysql-isolated；证书续期：scenarioforge-cert-renew.timer。80 端口和续期 timer 必须保持可用。
- 生产配置为 deploy/private/.env.local，根目录 .env.local 指向它；node_modules、Python .venv 和 deploy/private/runtime 是运行依赖，清理时保留。
- 模型凭据在数据库加密保存，恢复数据库必须配合原 SCENARIOFORGE_SETTINGS_KEY。不能用本机配置覆盖生产配置，也不能随意换加密密钥。
- 此次保持生产环境文件及加密密钥原值；Web 新增 `workspace-execution.conf` systemd drop-in，授予 Docker 补充组，并设置 `SCENARIOFORGE_EXECUTION_EXPORT_ROOT=/home/ubuntu/scenarioforge/deploy/private/execution-exports`。运行中 Web 已核对 Docker 组；导出目录属于服务用户、权限 0700，最终检查为空。保留 `PrivateTmp` 等原服务设置。
- SSH 私钥和数据库连接配置仍保存在用户原受保护位置，不放入源码包；远程 Git 私钥在服务器 deploy/private/repositories/credentials/<projectId>，仅公钥可展示。
- 历史交接备份目录：/home/ubuntu/scenarioforge/deploy/private/backups/handoff-20261108T095944Z。原记录包含源码、数据库压缩转储、Git 仓库、私有配置、前一构建对应源码和 SHA256SUMS，目录 0700、文件 0600，不加入对外交付包；本次回滚首先使用上方 2026-11-11 对应资料。
- 历史交接曾保留 .next-before-git-sync-20261108T093232Z（BUILD_ID=-1nRrYLITkMQekV6OumTQ）及备份中的 source-for-previous-build.tar.gz。此前两个 source-before-git-sync 历史包为空，不能用于恢复；该说明保留供追溯，不代表当前上一版本。
- 已检查压缩包可读性与校验值；尚未进行数据库恢复演练或异机重装验证。应用回滚时不能直接用旧数据库覆盖之后产生的用户数据。
- 最终磁盘记录为 `/dev/vda2`：总计 59G、已用 53G、可用约 4.0G（93%）。下次安装依赖、构建或备份前重新检查空间；保留本次回滚所需资料。
- HTTPS 证书当前可信，到期为 2026-11-16 19:33:09 UTC（北京时间 11 月 17 日 03:33:09）。续期 timer 为 active；检查时下次触发为北京时间 11 月 12 日 00:41:44。IP 证书有效期较短，后续时间以实际证书和 timer 状态为准。

```sh
systemctl is-active scenarioforge-web scenarioforge-mcp mysql-isolated
curl --fail http://127.0.0.1:3000/ -o /dev/null
systemctl is-active scenarioforge-cert-renew.timer
```

## 7. 已知限制与后续顺序

1. 正式生产使用前补自动备份、恢复演练及负载边界。当前研究队列最多两项并发，部分限流和 Python 用量额度在单进程内存，重启会清零。
2. Git 操作锁仅适用于单 Web 进程；扩容前改为共享锁。工作区 Agent 与本机 Runner 已于 2026-11-11 部署；本地命令需网页逐条审批并经无网络 Docker 容器运行。公网 Runner API 的配对、目录心跳和撤销已验证，实际 Runner CLI 与用户电脑目录、完整 GitHub Agent 链路仍待验收。
3. 真实研究的文档篇幅、来源可靠性和引用质量仍需专门验收；本次整理不额外调用收费模型或搜索。
4. 模型输入 token 没有累计硬上限，尚无项目月度金额预算；拆分和调度不保证总费用下降。
5. RAG/Embedding 代码已实现，但默认关闭；真实 Embedding 配置和检索质量尚未验收。搜索 Provider 已实现，运行配置仍需确认不是 `mock`。远程 MCP 仍暂缓。增加外部服务、模型调用范围或持续运维成本前，先向用户说明费用、数据去向和替代方案。

清理明细、空间回收及交付包校验记录见同目录 CLEANUP.md；完整历史见交付包根目录 handoff.md。

## 2026-11-10 工作区 Agent 状态补记

- 本机真实模型 + 本地 Runner + Docker 的联合验收已通过；验收报告与两张截图保留在被 Git 忽略的 `.tmp/local-docker-real-SNreFq/`。数据库测试 schema 和测试容器均已清理。正式验收摘要见 `docs/WORKSPACE_AGENT_VALIDATION_20261110.md`。
- 截至此阶段，工作区 Agent 和 Local Runner 源码及两条 MySQL 迁移尚未部署；2026-11-11 后将目录快照迁移一并纳入，并完成三条迁移及应用部署，见末尾服务器补记。此处保留 2026-11-10 的验收背景。
- 当时成功验收使用预置 `PLAN.md`，未覆盖现场生成与技能交接；2026-11-11 已新增显式续接入口，最新范围见下节。编码任务仍须用户手动「开始执行」，不以自动启动作为成功标准。
- 服务器到用户电脑 Runner 的 HTTPS 配对、GitHub Agent 完整工作流、真实 Embedding/RAG 质量验证仍待完成。Runner 尚无独立安装包；Docker 命令容器无网络且不带 `node_modules`。
- 此阶段曾发现 CLI 隔离说明有误；当前启动提示已修正为无网络 Docker、临时快照及容器写入丢弃，不再作为待修项。

## 2026-11-11 本地方案与执行流程补记

- 首次输入和已有对话均有「生成方案文档」按钮，直接将当前目标、讨论和资料整理为实际保存的 `PLAN.md` / `TASKS.md`。也可先用「发送」聊天，或明确要求联网调研后再生成方案。直接方案生成需要模型，但不联网、不运行代码，文件只表示待执行计划，不表示已验证来源、已修改项目或已通过测试。
- 「研究与对话」与「研究文档」位于执行区上方。文档可浏览、编辑保存或选择下载，下载不影响技能传递；已手改保存的 `PLAN.md` 或 `TASKS.md` 不自动覆盖，生成期间发生文档或资料变化时拒绝保存过期结果。
- 「使用这些文档继续执行」会将原目标带入执行要求，并从同项目技能列表中预选当前研究包已保存的文档。用户可调整要求、文件和工作方式，再手动「开始执行」；交接本身不创建任务，本地命令仍需逐条审批。任务启动时固定技能正文及版本，后续编辑不改变旧任务或恢复任务的快照。
- 研究进度排除执行事件；每张执行任务卡只展示对应执行 ID 的日志，避免研究、不同任务的进度混在一起。
- 本次方案、对话与工作区浏览器夹具回归共 21 项通过，全部 API 被拦截，不使用真实账号、数据库、模型或 Runner。方案离线测试 10 项通过；原有工作区 Agent 回归前 8 项首次通过，更新事务测试夹具后停止/恢复用例定向通过，共覆盖 9 项。详情见[本次验收报告](PLAN_WORKFLOW_VALIDATION_20261111.md)。
- 另一次真实联合验收使用独立 MySQL、生产模式 Next.js、真实网页与真实 Runner，模型使用本机 HTTP 夹具，无 API 费用。现场生成 PLAN/TASKS v1，编辑 PLAN v2 不自动排队且再生成返回 409；交接不执行，手动启动冻结 PLAN v2 / TASKS v1，原文升至 v3 后仍使用旧版。Agent 已落盘文件，完成静态检查和差异保存；验收方另行执行的可信 Node 测试 5/5 通过，这不是 Agent 命令或 Docker 验证。
- 临时测试库、3017 服务和 Runner 凭证均已清理；截图与原始报告保留在被 Git 忽略的 `.tmp/plan-joint-fixture-5xW8dW/`，可分享摘要见[方案流程验收报告](PLAN_WORKFLOW_VALIDATION_20261111.md)。2026-11-10 的真实模型 + Docker 成功记录仍只证明预置技能的本机链路。
- 当时后续计划中的源码及迁移部署现已完成；公网 Runner API 配对也已通过无模型验收。新入口的真实模型 + Docker 和人工审查、从生产 HTTPS 地址连接实际电脑 Runner、GitHub Agent 修改到人工合并、真实 Embedding/RAG 质量仍待验收。独立 Runner 安装包、依赖型测试、生产备份恢复、费用硬预算和多进程锁等既有待办继续保留。

## 2026-11-11 文档清单确认补记（当前入口）

本节更新当前使用方式；上节固定生成 `PLAN.md` / `TASKS.md` 的按钮与验收过程保留为历史记录。本次可编辑清单功能的验证范围见[方案流程报告的最新验收追记](PLAN_WORKFLOW_VALIDATION_20261111.md)，不能将此前联合验收视为新流程已完成真实模型与 Docker 验收。

- 首次输入和已有对话均默认「生成方案」，按钮现为「预览文档清单」；右栏空态为「根据当前需求规划文档」。先展示推荐名称、用途和内容要点，清单不是已保存文件，不进入技能列表。默认推荐两份 `PLAN.md` 和 `TASKS.md`，需求出现架构、接口设计、数据库、实验、风险、测试策略、里程碑等明确关键词时建议更多；这是本地规则，不调用模型、不联网，也不是 AI 语义规划。
- 用户可添加模板或自定义文档，修改名称、用途、要点，或移除条目；最终 1–20 份，文件名为英文字母开头的根目录 `.md`，禁止重名（忽略大小写）、路径、非 Markdown 和系统保留名。点击「确认并生成 N 份文档」才会调用一次模型生成正文，不自动重试；「暂不生成」只收起清单，刷新仍能恢复，不会触发模型。修改需求后应重新预览清单。
- 未选的旧文件保留。任意所选目标文件已由用户手改保存后都拒绝自动覆盖，请移除该目标、换名或继续手工完善。预览后资料或文档变化时，保留清单编辑内容并禁止确认，须点击「重新预览清单」检查新建议；确认冲突也保留输入，生成期间发生变化则拒绝保存过期结果。
- 清单经既有研究事件持久化，`documents_plan_ready` 对应 `taskState=idle`，只有确认生成才排队。`POST /api/research/:id/documents` 分为 `action: "preview"` 与 `action: "generate"`，字段和冲突规则见[开发说明](DEVELOPMENT.md)。本功能不增加数据库表或迁移；执行、Runner 及目录快照三条迁移已于此次服务器发布应用。
- 正文生成后按原流程浏览、编辑、保存、可选下载，再「使用这些文档继续执行」。交接选择当前包实际保存的文档，清单不直接传给 Agent；仍须手动「开始执行」，技能版本固定和本地命令审批保持不变。完整操作见[使用手册](USER_MANUAL.md)。
- 待办继续包括新入口的真实模型 + Docker 与人工审查联合验收、线上 Runner CLI 与实际电脑目录的配对/断线/恢复、GitHub Agent 完整流程、真实 Embedding/RAG 质量、Runner 安装包、依赖型测试、生产恢复演练、费用硬预算及多进程协调。生产部署及迁移、无模型公网 Runner API 验收现已完成。

## 2026-11-11 双页签工作区补记（当前布局）

当前项目工作区已分为「方案与文档」和「执行工作区」，不再纵向同时铺开研究、文档与全部执行任务。此前“研究位于执行区上方”的说明和验收截图保留为历史布局；本轮验证范围以[方案流程报告最新追记](PLAN_WORKFLOW_VALIDATION_20261111.md)为准。

- 方案页签保留对话与 Markdown 双栏；执行页签集中显示目标目录、技能、要求、任务进度、验证与差异。顶部固定显示项目、当前工作方式、连接状态及本地目录，支持目录展开/复制；有本人待审批的命令时显示数量和进入执行页签的入口。
- 「使用这些文档继续执行」自动切到执行页签并带入已保存技能与原目标，仍由用户手动「开始执行」，不跳过本机命令审批。切换页签保留对话和执行草稿、清单修改、文档编辑、技能/Runner 选择和差异状态；后台任务继续更新，隐藏页签不抢夺焦点或滚动。
- 当前任务展开；没有活动任务时显示最近任务，其余已结束任务默认折叠在「历史任务」。配对及命令运行说明在「连接与运行设置」中。项目个人 Agent 收件箱默认收起，个人中心模型设置保留展开；“我的下一步”、收藏及文档/研究深链仍能打开并定位对应内容。
- 页签 URL 使用 `workspace=execution`，切换只替换当前历史项；选择新项目或研究清除此参数。两个面板持续挂载，现有数据库、模型、队列与执行权限不变；此布局开发阶段没有新增迁移，随后随本版统一部署。真实模型/Docker、实际远程 Runner、GitHub 完整流程和 RAG 等后续验收事项继续保留。

## 2026-11-11 服务器部署与验收补记（最新线上状态）

北京时间 13:49:45 将代码 `662e5ed` 切换至 `https://175.27.143.14`，BUILD_ID 为 `Zwkz6k8STTt7AjaAP6_-b`；13:50:02 完成无模型公网验收，13:51:23 完成只读收尾。三条新迁移已应用，生产共 14 条有效迁移。私有配置原值保持不变，MCP 未重启；Web 的 Docker 权限和独立导出目录通过 drop-in 配置并核对运行状态。

- 独立源码目录安装依赖、生成 Prisma Client，以 4G 内存、200% CPU、600 秒上限构建成功。Linux 离线组合 133/133、独立数据库 19/19、真实 Docker 1/1 通过；Docker 覆盖错误实现失败、修复后通过及隔离断言。独立验收库 `scenarioforge_test_release_20261111` 和账号 `sf_release_20261111` 已删除。
- 公网首页与 11 项静态资源正常；双页签及研究两栏资源存在。新临时账号的注册、登录、Secure Cookie、登出均通过；文档 `preview` 返回 `PLAN.md` / `TASKS.md` 清单且保持 idle、无文件、无模型/Embedding/执行队列，未调用 `generate`。
- 直接 HTTPS API 客户端验证 Runner 单次配对码、目录上报与在线心跳、拒绝改绑、撤销后 401。全部临时用户、项目、研究包和 Runner 已清理；这次没有启动 Runner CLI，也没有连接或修改用户电脑目录。
- 八项未登录 API 返回 401；公网 `/api/internal/deployment-check` 返回 404。Web、MCP、MySQL 和证书续期 timer 为 active；生产环境文件哈希与部署前一致，导出目录为空。
- 此次没有真实模型调用，没有线上浏览器布局交互，没有实际 PC Runner 链路，也没有完整 GitHub Agent 验收。新入口真实模型生成正文 → 技能交接 → 工作区修改 → Docker → 人工审查，仍需单独授权并验收。RAG 保持关闭。

版本、归档哈希、备份位置、证书和磁盘状态详见[本次上线记录](DEPLOYMENT-20261111.md)。
