# ScenarioForge

先研究，再创作的团队项目与 AI 协作工作区。围绕项目研究、成员分工、成果交付与 Git 协作，让团队共同完成工作，也让每位成员看见自己的下一步和贡献积累。

**源码版本：2026-11-11；最近记录的在线版本：2026-11-09。** 本仓库包含最新工作区 Agent、本地 Runner、可编辑文档清单及双页签界面，见[本版更新说明](docs/RELEASE_NOTES_20261111.md)。本次仅更新源码，未部署服务器；[在线站点](https://175.27.143.14/)的最近部署记录仍为 [2026-11-09](docs/DEPLOYMENT-20261109.md)，不能用在线页面判断本版新功能是否存在。

**当前闭环：** 输入想法 → 预览并确认 1–20 份 Markdown → 生成正文 → 选择文档作为技能 → 手动启动 Agent → 修改本地目录或 GitHub 任务分支 → 验证并审查。清单预览使用本地规则，不调用模型；正文生成才调用模型。技能在任务启动时固定内容和版本，本地命令须逐条审批。最新组合浏览器回归 42/42、另五项集成用例分次通过，方案离线回归 15/15；独立 MySQL、生产模式 Next.js、真实网页与 Runner 联合验收通过，模型使用本机 HTTP 夹具，独立 Node 测试 5/5。新入口的真实模型 + Docker 全链路仍待验收；2026-11-10 的真实模型成功记录使用预置技能。详见[验收范围](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)。

| 想做什么 | 从哪里开始 |
| --- | --- |
| 使用网页、生成文档并交给 Agent | [详细使用手册](docs/USER_MANUAL.md) |
| 让 Agent 修改自己电脑上的目录 | [本地 Runner 安装、配对与审批](docs/LOCAL_RUNNER.md) |
| 理解执行限制、技能版本和 GitHub 模式 | [工作区 Agent 说明](docs/WORKSPACE_AGENT.md) |
| 配置模型、数据库与开发服务 | 下方[新成员快速上手](#新成员快速上手)、[环境示例](.env.example)、[开发说明](docs/DEVELOPMENT.md) |
| 部署到服务器或接续开发 | [Ubuntu 部署](deploy/README.md)、[交接与待办](docs/HANDOVER.md)、[本版部署前检查](docs/RELEASE_NOTES_20261111.md#部署与后续工作) |

[方案与文档界面](docs/evidence/workspace-research-20261111.png) · [执行工作区界面](docs/evidence/workspace-execution-20261111.png) · [手机界面](docs/evidence/workspace-mobile-20261111.png)。截图使用模拟资料，不代表真实模型生成质量。

## 主要功能

| 模块 | 当前能力 |
| --- | --- |
| 账号与项目 | 注册、登录、创建项目、六位邀请码加入，以及项目成员访问控制 |
| 团队研究 | 团队 Agent 对话、联网研究、证据与来源、人工澄清、显式生成方案文档、编辑与导出；本地版本可确认文档后交给工作区 Agent |
| 工作区 Agent | 版本化 Markdown 技能、用户目录 Runner 与 GitHub 任务分支、文件修改、操作进度、Docker 验证、本机命令审批及差异审查；尚未部署到在线站点 |
| 个人 Agent | 按项目配置个人模型、接收团队任务、私有讨论、修改初稿并确认提交；个人中心统一管理工作偏好 |
| 团队共享资料 | 显式分享研究证据、关键词检索、归档与恢复，供团队后续研究复用 |
| 团队 Git 工作区 | 导入已有内容或私有 GitHub 仓库，浏览、上传、编辑文件，管理个人工作分支、提交历史、审查合并、快进拉取和推送 |
| 我的下一步 | 主页汇总跨项目待处理与等待事项，支持个人项目星级、任务截止日期识别、个人日期设置及直接定位任务 |
| 个人中心 | 昵称、简介、技能、本地头像、个人 Agent 偏好、密码与登录设备管理，以及收藏、标签和笔记 |
| 贡献与成长 | 贡献审核、经验账本、项目筛选、撤销回退和七级成长卡片，最高为 Lv.7「项目狂人」 |

Git 工作区管理的是每个项目关联的仓库；本仓库保存 ScenarioForge 网站的完整源码。两者的用途与发布流程各自独立。

## 本次更新

- **项目工作区双页签（2026-11-11，尚未上线）**：项目内分为「方案与文档」和「执行工作区」，顶部固定展示项目、当前工作方式、目录与连接状态；有待批准命令时显示提示，可直接进入执行页签。「使用这些文档继续执行」自动切到执行页签并带入文档及要求，仍须手动开始。切换保留对话输入、清单修改、文档编辑、执行要求与任务查看状态；当前任务展开，历史任务与项目个人 Agent 收件箱默认收起。配对与命令运行说明放在「连接与运行设置」内。验证范围见[验收报告最新追记](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)。
- **本地目录与操作进度（2026-11-11，尚未上线）**：连接区显示 Runner 实际目录，任务卡保留执行时目录，支持展开和复制；进度展示读取技能/文件、保存变更、等待模型/审批及验证结果，可展开查看细节与实测耗时。本地执行详情仅发起者可见，旧任务缺少的目录和操作不补造。需新增目录快照迁移并重启旧 Runner，无需重新配对。浏览器 15/15、独立数据库 10/10、类型检查、lint 和生产构建通过，具体证据见[验收追记](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)。
- **文档清单确认与执行流程（2026-11-11，尚未上线）**：首次输入与已有对话的「本次操作」均默认选择「生成方案」，点击「预览文档清单」先得到可编辑的推荐，确认前不生成正文。默认推荐 `PLAN.md` 和 `TASKS.md`，按明确关键词追加架构、接口、数据模型或实验等模板；可以修改文件名、用途和内容要点，添加模板或自定义文件，保留 1–20 份后点击「确认并生成 N 份文档」。预览只用本地规则，不调用模型、不联网，也不是 AI 语义规划；确认生成才调用一次模型，无自动重试。要聊天或明确要求联网调研时，先切换「仅讨论」。右栏空态入口为「根据当前需求规划文档」。桌面两栏各自滚动，移动端竖向排列；方案不表示已联网核实或已通过测试。
- **跨项目行动推荐**：个人可为项目设置 1–5 星优先级；同星级再结合紧急程度、阻塞情况等推荐下一步。该模块仅显示在主页，点击事项可定位原任务。
- **任务截止日期**：只识别任务描述中的明确时间，不把项目截止时间当作任务截止时间；描述未指定时，可设置自己的截止时间。相对日期以任务创建时间为基准。
- **个人中心**：集中管理资料、个人 Agent、账号安全和收藏；头像支持 JPG、PNG、WebP，最大 5 MB，处理后保存为 256×256 图片。
- **个人工作偏好**：回答风格、技术偏好、交付格式与工作习惯会传入个人 Agent 的初稿和后续对话；具体任务和本轮要求优先。
- **贡献记录**：项目创建者认可已提交任务、独立共享成果和已完成研究阶段后计入经验；同一来源重复确认不重复加分，撤销认定会回退关联经验。
- **七级成长卡片**：等级随累计经验变化，从浅绿逐步升级为青蓝、紫晶和金色装饰；最高级使用深色金光样式，等级图鉴可以预览全部样式。
- **Git 与研究流程完善**：本版本包含已有/私有仓库导入、文件上传编辑、分支与历史管理，以及研究文档输出截断识别和有限重试等此前迭代。

### 经验等级

| 等级 | 名称 | 累计经验 | 定位 |
| --- | --- | ---: | --- |
| Lv.1 | 探索者 | 0 | 从了解项目、加入团队开始，寻找自己可以参与的方向。 |
| Lv.2 | 参与者 | 100 | 已留下被认可的贡献，开始成为团队协作的一员。 |
| Lv.3 | 实践者 | 300 | 通过多次有效交付，把自己的想法转化为项目成果。 |
| Lv.4 | 共建者 | 700 | 持续参与任务与协作，和其他成员共同完善项目。 |
| Lv.5 | 中坚者 | 1,500 | 积累了丰富的有效贡献，为团队推进提供稳定支持。 |
| Lv.6 | 领航者 | 3,000 | 长期贡献成果与经验，帮助团队和更多成员共同成长。 |
| Lv.7 | 项目狂人 | 9,999 | 将持续创造与团队协作变成习惯，让每一次投入都留下成果。 |

任务交付通过审核 +30、独立成果被采纳 +10、有效审查 +10、参与完成里程碑 +20。经验按账号跨项目累计，等级不改变项目权限；登录、聊天和模型调用次数不计分。第一版将已完成的研究包作为里程碑，只有该阶段已有认可交付或成果的成员可获得奖励。完整规则见 [贡献与等级说明](docs/CONTRIBUTIONS.md)。

## 技术与运行方式

Next.js 16、React 19 和 TypeScript 提供网页与 API；Prisma 管理 MySQL 数据；OpenAI Agents SDK 与 Python FastMCP 协调研究和模型调用；Git 工作区保存在服务器。生产使用 systemd 常驻服务和 nginx HTTPS 入口。

配置真实模型与搜索服务后，Agent 可根据目标和参考资料规划研究、整理证据并生成中文 Markdown。默认 `SEARCH_PROVIDER=mock`、`RAG_ENABLED=false`；Mock 来源不能作为真实证据，Embedding 需要单独配置。账号、项目、个人资料与贡献管理不依赖真实模型调用。

部署说明见 [Ubuntu 部署](deploy/README.md)。网页使用者直接访问站点即可；开发者按下文准备独立环境。已有服务器的 Windows 开发连接方式另见 [本地开发说明](docs/LOCAL_DEVELOPMENT.md)，该文档描述的共享数据库配置不应作为新开发者的默认测试环境。

## 新成员快速上手

完整研究流程包含两个常驻服务；本地开发也可使用相同架构：

- Next.js：账号与项目、网页、API、MySQL 数据访问、任务队列和搜索适配器。
- Python FastMCP：研究工具、MCP 接口和模型调用。

两个服务共用项目根目录的 `.env.local`。模型令牌只在服务端使用，不会发送到浏览器。

### 1. 准备环境

需要 Node.js 22.12+、Python 3.11+、Git、`uv`，以及可连接的 MySQL 8.4 数据库。检查运行时版本：

```powershell
node --version
npm --version
python --version
git --version
uv --version
```

没有 `uv` 时安装：

```powershell
python -m pip install uv
```

### 2. 安装应用依赖

```powershell
git clone https://github.com/Dmool-wyzy/ScenarioForge.git ScenarioForge
cd ScenarioForge
npm ci
Copy-Item .env.example .env.local
cd mcp-server
uv sync --locked
cd ..
```

### 3. 配置 `.env.local`

先配置项目专用 MySQL 账号、CA 证书路径、浏览器访问来源和两个服务共用的内部令牌。密码中的保留字符需要 URL 编码，CA 路径使用实际绝对路径：

```env
DATABASE_URL="mysql://project_app:数据库密码@127.0.0.1:3307/projectdb?sslcert=/absolute/path/mysql-ca.pem&sslaccept=strict"
SCENARIOFORGE_PUBLIC_ORIGIN=http://localhost:3000
SCENARIOFORGE_INTERNAL_TOKEN=至少32字符的随机字符串
```

开发时的来源必须与浏览器地址完全一致（协议、主机和端口）；改用 `127.0.0.1` 或其他端口时同步调整。生产使用实际 HTTPS 来源，例如 `https://175.27.143.14`，生产会话 Cookie 带 `Secure`，不能用 HTTP 代替正式登录入口。

项目创建者可以在项目页展开“模型 API 设置”，填写 HTTPS API Base URL、API Key、模型 ID、协议及超时，再保存。成员只能查看配置元信息，无法查看、修改或测试 API Key。留空 Key 会保留已保存的凭据；保存成功后密码输入框清空。测试连接与保存是两个独立操作，测试会发送最小模型请求，可能产生少量费用。

服务器必须先设置 `SCENARIOFORGE_SETTINGS_KEY`，才能加密保存项目 API 配置。该值是 **32 字节随机数据的 base64 编码**，由管理员在服务端生成一次：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

将结果写入私有配置的 `SCENARIOFORGE_SETTINGS_KEY`，不使用 `NEXT_PUBLIC_` 前缀。与数据库备份分开私密保管；恢复保存的 API 配置和执行快照需要原密钥。不要直接替换或丢失此值，项目没有自动密钥轮换工具。

管理员也可以通过环境变量设置服务器默认模型配置，未保存项目配置时使用：

```env
OPENAI_API_KEY=项目专用模型令牌
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_MODE=responses
SCENARIOFORGE_MODEL=服务商实际支持的模型名
```

每轮研究开始时使用配置快照。修改或清除项目配置不影响进行中的轮次；后续新轮次使用最新项目配置。清除项目配置后，新轮次回到服务器默认配置（若管理员已填写），不会继续使用已清除的项目凭据。搜索及独立 Embedding 仍按服务端配置启用。

生成内部令牌：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

连接配置完成后生成客户端并应用 MySQL 迁移：

```powershell
npm run db:generate
npm run db:deploy
```

`prisma/migrations` 是当前 MySQL 迁移历史，文档、会话和向量等长文本已适配。原 SQLite 迁移保留在 `prisma/sqlite-migrations`，不能直接应用到 MySQL。已有匿名研究包的导入必须显式指定项目及成员归属；未归属的研究包不会自动对所有用户开放。升级已有数据库前先备份，生产不运行 `db:migrate` 或 `db push`。

`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_API_MODE`、`SCENARIOFORGE_MODEL` 和 `MODEL_TIMEOUT_SECONDS` 如果写在项目 `.env.local` 中，会覆盖系统同名变量。空的项目 key 会直接报错，不会回退到系统 key。修改配置后必须重启两个服务。

不要提交 `.env.local`、真实令牌、数据库、依赖目录、缓存或日志；`.env.example` 才是可以提交的配置模板。

### 4. 启动两个服务

窗口一：

```powershell
cd mcp-server
uv run main.py
```

默认 MCP 地址是 `http://localhost:8000/mcp`。

窗口二（项目根目录）：

```powershell
npm run dev
```

默认网页地址是 <http://localhost:3000>。开始研究前，两个窗口里的服务都必须保持运行。如果 PowerShell 找不到 `uv`，可运行 `mcp-server\.venv\Scripts\uv.exe run main.py`。

### 5. 第一次使用

先注册／登录，再从“我的项目”创建项目或输入六位邀请码加入。用户名为 3–32 位字母、数字或下划线，密码为 8–128 位。创建成功后进入项目工作区并显示邀请码；对方也需先登录，再输入邀请码加入。同一成员再次加入会回到原项目，不会重复添加。

在本地 2026-11-11 版本的项目内输入目标和约束，「本次操作」默认选中「生成方案」。点击「预览文档清单」，右侧先显示名称、用途和内容要点；首次提交与已有对话采用相同规则。默认两份是 `PLAN.md`（目标、范围和步骤）及 `TASKS.md`（任务和验收清单）；出现「数据库」「实验」「接口设计」等明确关键词时，会推荐相关模板。推荐来自本地规则，不调用模型、不联网，不是 AI 对任务复杂度的语义判断。你可以增删、改名或补充要点，也可以选择「暂不生成」；清单尚不是文件，不会进入技能列表。确认 1–20 份后点击「确认并生成 N 份文档」，才会用一次模型请求生成正文，无自动重试，不修改项目或运行测试。

要先讨论时，显式选择「仅讨论」再发送；需要外部证据时在该模式中明确要求联网调研，并先配置真实模型与搜索服务。联网研究按需要展示问题、文件计划和澄清，常见交付文件为 `README.md`、`RESEARCH.md`、`SOURCES.md`，与上述方案清单是不同路径。如果当前对话的右栏仍为空，可点击「根据当前需求规划文档」。若预览后资料或文档发生变化，先保留当前修改并点击「重新预览清单」，检查新清单后再确认。

在「方案与文档」页签的「研究文档」浏览、编辑并保存生成文件；下载单文件或 ZIP 是可选操作。点击「使用这些文档继续执行」会切到「执行工作区」，将当前研究包已保存的文档作为技能，连同原目标带入执行表单。先检查版本、调整技能和执行要求、选择本地目录或 GitHub 仓库，再手动「开始执行」。切换页签保留当前输入与编辑状态；后续编辑文档不会改变旧任务的技能版本。本地命令仍需逐条审批，顶部提示待审批状态；清单中未选的旧文件会保留，已手动修改的目标文件不会被生成器覆盖，请移除该目标、改用新文件名或继续手动完善。

上传支持 Markdown、UTF-8 TXT、含文本 PDF 和 DOCX；每个研究包最多 5 个文件，每个不超过 5 MB，每份提取文本最多 20,000 个字符。扫描版 PDF 不做 OCR。

## 参与代码开发

开始工作前同步主分支：

```powershell
git switch main
git pull --ff-only
```

为功能创建分支：

```powershell
git switch -c feat/简短描述
```

提交前查看 `git diff`，确认没有本地配置和数据库，再运行：

```powershell
npm run lint
npm run typecheck
git add .
git commit -m "说明这次修改"
git push -u origin feat/简短描述
```

上述流程适用于通过 Pull Request 合并的协作方式。若仓库仅维护 `main`，并允许直接提交，也可以先同步远程 `main`，在其现有历史上追加经过检查的版本更新提交，再普通推送；若有分支保护，则使用更新分支和 Pull Request。不要通过强制推送覆盖原有提交历史。

## 常见问题

- **MCP 连接失败**：确认 Python 服务仍在运行，且两个服务的 `SCENARIOFORGE_INTERNAL_TOKEN` 完全相同。
- **模型连接超时**：检查 `OPENAI_BASE_URL`、模型名、API 模式和网络。项目不会在超时或 HTTP 错误后自动重试。
- **日志显示系统令牌**：确认项目 `.env.local` 中存在非空的 `OPENAI_API_KEY`，然后重启两个服务。
- **数据库迁移失败**：先停止 Next.js，再运行 `npm run db:generate` 和 `npm run db:deploy`。不要修改已提交的迁移文件。
- **预览清单后没有文档**：这是确认前的正常状态；检查右侧「确认文档清单」，调整内容后点击「确认并生成 N 份文档」。提示资料或文档已更新时，需重新预览；接口冲突会保留当前清单输入，请按提示处理。只有确认后才应出现 `documents_requested → documents_started`。
- **历史故障：确认生成后仍只聊天、右栏为空**：此前排查发现旧开发进程的全局定时器仍持有旧 Worker，出现 `documents_requested → turn_started`；已通过动态更新调度回调和升级旧定时器修复，并在确认无排队、运行任务后重启网页服务。`npm run check:task-scheduler` 的 2 项离线回归通过；最终生产构建、lint、类型检查及 10 项方案测试通过。默认操作和布局调整后的浏览器补验 26/26 通过（方案 6、对话 9、执行区 11）；前述 21 项保留为此前验证记录，独立环境联合补验结果以[专项追记](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)为准。

新建数据库迁移使用：

```powershell
npm run db:migrate -- --name 描述这次修改
```

现有 RAG 支持来源版本、独立 Embedding、MySQL 持久化向量、应用内余弦检索、逐文件证据注入、可点击引用与证据索引导出。成员权限以团队项目为边界，证据检索仍按研究包隔离。配置、迁移、架构、API/MCP、CLI 和测试见 [RAG 使用说明](docs/RAG.md)。默认 `RAG_ENABLED=false`，开启前需配置独立 Embedding 并验收。

## 开发环境

- Node.js 22.12+（当前开发环境为 Node.js 24）
- Python 3.11+、uv（MCP 服务阶段接入）
- MySQL 8.4，表结构和迁移由 Prisma 管理

## 本地启动

```powershell
npm ci
Copy-Item .env.example .env.local
# 编辑 .env.local，填写自己的凭据。
npm run db:generate
npm run db:deploy
```

安装 uv：`python -m pip install uv`。然后使用两个终端：

```powershell
# 终端 1：MCP Server
cd mcp-server
uv sync --locked
uv run main.py
```

```powershell
# 终端 2：Next.js
npm run dev
```

访问 <http://localhost:3000>。两个服务共用根目录 `.env.local`。首次 MCP 工具调用前需要 Next.js 已启动；两个进程的启动顺序不限。

模型配置优先读取项目根目录 `.env.local`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_API_MODE`、`SCENARIOFORGE_MODEL` 和 `MODEL_TIMEOUT_SECONDS` 在文件中存在时覆盖系统同名变量。空的项目 key 会报错，不会回退到系统 key。未写入文件的配置仍可从环境变量读取；系统变量本身不会被修改。隔离测试可用 `SCENARIOFORGE_ENV_FILE` 指向独立配置文件，设为空字符串则仅使用测试进程环境。

本次工作环境的 uv 安装在项目虚拟环境中，可先执行 `mcp-server\.venv\Scripts\Activate.ps1`，再使用 `uv`。如果 PowerShell 限制激活脚本，可在 `mcp-server` 目录直接运行 `.venv\Scripts\uv.exe run main.py`。

新增迁移使用 `npm run db:migrate -- --name <name>`。

`.env.local`、数据库、依赖目录均不提交。模型与搜索凭据仅供服务端使用。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 模型 API key，仅在服务端使用 |
| `OPENAI_BASE_URL` | 默认 `https://api.openai.com/v1`，支持兼容中转站；填写纯 URL |
| `OPENAI_API_MODE` | `responses` 或 `chat_completions`，Next.js 与 Python 使用相同配置 |
| `MODEL_TIMEOUT_SECONDS` | Node.js 与 Python 模型请求超时，默认 120 秒，范围 10–300；Node 建连使用同一上限；超时/HTTP 错误不自动重试 |
| `SCENARIOFORGE_MODEL` | 所有业务模型调用的模型名；真实研究前须填写服务商实际支持的名称 |
| `SEARCH_PROVIDER` | `mock`（默认）、`searxng`、`ddgs` 或 `tavily` |
| `SEARXNG_URL` | SearXNG 服务地址，仅 searxng 需要 |
| `TAVILY_API_KEY` | 仅 tavily 需要；其他搜索方式可以留空 |
| `TAVILY_MAX_RESULTS` | Tavily 单次结果上限，默认 5 |
| `MAX_SEARCH_RESULTS_PER_QUESTION` | 每个研究问题最多保留的搜索结果数，默认 5，范围 1–20 |
| `SEARCH_TIMEOUT_MS` | 搜索请求超时，默认 30000 毫秒，范围 1–120000 |
| `SCENARIOFORGE_MCP_URL` | 默认 `http://localhost:8000/mcp` |
| `DATABASE_URL` | 必填 MySQL URL；账号、数据库及 CA 路径使用实际配置，生产保持证书校验 |
| `SCENARIOFORGE_PUBLIC_ORIGIN` | 浏览器的完整来源；开发示例 `http://localhost:3000`，生产为实际 HTTPS 来源 |
| `SCENARIOFORGE_INTERNAL_TOKEN` | 两个服务共享的内部凭据，至少 32 字符；不要使用示例占位值 |
| `SCENARIOFORGE_SETTINGS_KEY` | 仅服务端使用的 32 字节随机 AES 密钥，base64 编码；保存项目 API 配置前必填，私密备份且不可直接更换 |
| `SCENARIOFORGE_BACKEND_URL` | MCP 访问 Next.js 的地址，默认 `http://localhost:3000` |

生成内部凭据可运行 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`，将输出填入 `.env.local`。禁止设置任何 `NEXT_PUBLIC_*` API key。

注册／登录、项目管理、已有文件预览和下载不依赖外部模型 key，但需要数据库和对应项目的成员权限。开始或继续研究时会检查当前项目配置或服务器默认配置。中转站需支持所选模式的 API 和 function/tool calling。Chat Completions 模式通过强制函数调用和本地 JSON Schema 校验获得结构化结果；Responses 模式使用 JSON Schema Structured Outputs。不会静默切换模式或替换模型名。

## 搜索 Provider

通过根目录 `.env.local` 的 `SEARCH_PROVIDER` 切换搜索服务。可以从 `.env.example` 复制搜索配置块到已有 `.env.local`，保留自己的模型、数据库和内部凭据；修改后重启 Next.js 和 Python MCP 服务。未设置时使用 mock，不需要 Tavily key；Mock 仅替代搜索，研究规划与证据整理仍需要模型凭据。

| Provider | 是否需要 key | 适用场景 |
| --- | --- | --- |
| mock | 否 | 本地开发、离线搜索测试，不消耗搜索额度 |
| searxng | 否 | 推荐：自建免费搜索；实例需启用 JSON 输出 |
| ddgs | 否 | 免费搜索，依赖 Python MCP Server 的 DDGS endpoint |
| tavily | 是 | 使用 Tavily Search API |

### 使用 SearXNG

已有服务时，在其 `settings.yml` 中设置 `search.formats: [html, json]`，重启后配置：

```env
SEARCH_PROVIDER=searxng
SEARXNG_URL=http://localhost:8888
```

本地 Docker 示例（需已安装并启动 Docker）：

```powershell
New-Item -ItemType Directory -Force .tmp/searxng | Out-Null
@'
use_default_settings: true
server:
  secret_key: "local-development-change-this-secret"
  limiter: false
search:
  formats:
    - html
    - json
'@ | Set-Content -Encoding utf8 .tmp/searxng/settings.yml
docker run --rm --name scenarioforge-searxng -p 127.0.0.1:8888:8080 -v "${PWD}/.tmp/searxng:/etc/searxng" docker.io/searxng/searxng:latest
```

这个示例仅绑定本机；部署共享实例前更换 secret_key 并配置访问与限流。若搜索返回 403，检查 JSON 输出和实例访问权限。

### 使用 DDGS

```env
SEARCH_PROVIDER=ddgs
SCENARIOFORGE_MCP_URL=http://localhost:8000/mcp
```

在 `mcp-server` 执行 `uv sync --locked`、`uv run main.py`。DDGS 已列入 Python 依赖；Next.js 使用共享内部凭据调用 `POST /internal/search/ddgs`。endpoint 与 MCP 使用同一主机及端口，内部凭据沿用 `.env.local` 的 `SCENARIOFORGE_INTERNAL_TOKEN`。DDGS 可能被上游限流；失败或空结果会明确报错，不补造来源。

每个研究问题生成简短的互补查询。某条查询超时或无结果时，会尝试本轮其余查询（最多 3 条），不重新调用模型生成查询；已有来源可继续整理为证据。所有查询均失败时停止本轮，鉴权、配置或限流错误则立即停止。`SEARCH_TIMEOUT_MS` 是单条查询的搜索预算，Next.js 调用本地 DDGS endpoint 时额外留出 5 秒接收结构化错误。

### 使用 Tavily

```env
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-your-key
```

仅此 Provider 检查 Tavily key；401/403 提示检查 key，429 提示限流或额度不足。`TAVILY_MAX_RESULTS` 是 Tavily 的额外上限，实际请求取它与本次请求数量的较小值。

### 确认当前 Provider 与故障表现

研究时间线显示 `[provider]`、实际查询词及结果数量。持久化的 `search_started` / `evidence_found` 事件还包含 query、provider、fetchedAt，失败时有 `search_failed` 的 code 和中文原因；可通过研究包快照或 SSE 查看。

Mock 固定返回最多三条 `https://example.com/mock/...` 示例，每条带 `[MOCK SEARCH RESULT]`，证据会强制标为低置信度、待确认。真实 Provider 失败时不会回退到 Mock；Agent 得到搜索不可用的明确提示，未成功完成检索与证据保存的问题不会通过正文生成校验。已有文件仍可查看和下载。

## 架构

```mermaid
flowchart LR
    U[浏览器：登录 / 项目 / 研究工作区] --> API[Next.js Route Handlers / 成员鉴权]
    API --> DB[(Prisma / MySQL)]
    DB --> W[数据库任务调度]
    W --> A[OpenAI Agents SDK]
    A -->|Streamable HTTP| M[Python FastMCP]
    M --> L[配置的模型 API]
    API --> S[统一 Search Provider]
    S --> T[Mock / SearXNG / Tavily]
    S -->|DDGS 内部 HTTP| M
    M -->|内部凭据| API
    API -->|SSE 持久化事件| U
```

Next.js 统一管理数据库和文件版本；Python 通过受保护的内部接口读写研究包。工作区存放在数据库中，下载时生成文件或 ZIP，不提供任意本地文件系统访问。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `create_research_package` | 创建或复用研究包，规划研究问题与文件清单 |
| `search_scenario` | 改写查询、搜索、去重并整理带来源的证据卡 |
| `generate_workspace` | 综合证据，按已公布的文件计划生成文档 |
| `update_file_plan` | 为研究中发现的新主题追加文件计划或完善用途说明 |
| `ask_user` | 发起文本、单选或多选澄清问题 |
| `get_user_answers` | 获取答案、等待或应用超时策略 |
| `read_workspace_file` | 获取最新文件内容和版本 |
| `write_workspace_file` | 带版本校验写入文件，遵守锁和用户原文保护 |
| `export_workspace` | 返回 ZIP 下载地址和文件列表 |
| `get_research_package` | 读取结构化问题、状态、证据统计、文件元数据和澄清 |
| `search_evidence` / `get_evidence` | 项目内向量检索与完整证据回查 |
| `get_file_context` | 取得指定计划文件的有界 RAG 上下文与保存元数据 |
| `answer_user` | 从 CLI 或下游 MCP 客户端提交澄清回答 |
| `update_workspace_file` | `write_workspace_file` 的兼容别名，遵守同样的版本、引用及用户保护 |

工具检查说明见 [mcp-server/README.md](mcp-server/README.md)。

## 工作区与限制

- 联网研究路径的基础输出为 `README.md`（概览与导航）、`RESEARCH.md`（研究与证据）、`SOURCES.md`（来源索引），可按研究计划增加其他文件，简单场景可只保留三份基础文档。该路径的文件计划展示名称、用途、优先级（required / recommended / optional）和内容要点，最多 20 项；研究中可先追加计划，再创建文件。
- 显式「生成方案」路径先用本地规则预览可编辑清单，默认 `PLAN.md` 和 `TASKS.md`，按明确关键词推荐更多模板；可添加自定义文件，确认 1–20 份才调用模型生成正文，不要求先跑联网研究。推荐并非 AI 语义规划，修改需求后需重新预览；清单不等于已保存文件，也不直接进入技能。正文只用一次模型请求，无自动重试。
- 两条路径的文件名都使用英文字母开头的字母、数字、下划线或连字符，以 `.md` 结尾，禁止目录和系统保留名；方案清单不允许忽略大小写后的重名，名称主体最多 80 个字符。方案清单中的用途和内容要点都需要填写。
- 上传：最多 5 个文件，每个不超过 5 MB；支持 MD、UTF-8 TXT、含文本的 PDF 和 DOCX；每份提取文本最多保留 20,000 字符。扫描 PDF 不包含 OCR。
- 每包最多 12 次新检索，通过计划中问题的编号（从 0 开始）关联证据和进度。已完成的问题直接复用证据，不扣额度、不调用模型；计数达到 12 后仍可生成文件。每次生成 2–3 个简短查询，每个查询默认最多 5 个结果；达到结果上限后停止补充查询。
- 每包最多 2 轮澄清、共 6 个问题；默认等待 600 秒；每个 Agent 执行轮次最多 24 步、20 分钟。
- 编辑锁每 30 秒续期，无续期时 120 秒后释放。未保存草稿存放在当前浏览器窗口的 sessionStorage。
- 用户最后保存的全文受到保护。Agent 可以追加保留原文的建议；联网研究整包重新生成会保留用户已编辑的文件。方案生成发现任意所选目标由用户编辑过时会拒绝覆盖，请移除该目标、换名或继续手动完善，未选旧文件不会删除；存在编辑锁、阻塞问题或运行中的任务时，应先处理。预览后上下文变化须重新预览，生成期间发生资料或版本变化时拒绝保存过期结果。
- 联网研究未启用 RAG 时也逐文件生成、逐文件保存，每次工具调用最多处理三份文件；`SOURCES.md` 直接整理已保存的真实来源，不调用模型。中断后复用已有证据和当前内容的检查点，继续缺失文件。方案正文则在确认后用一次结构化请求生成所选文档。单次模型请求默认等待 120 秒，模型超时、限流或连接失败均不自动重试，可通过 `MODEL_TIMEOUT_SECONDS` 设置 10–300 秒。
- 单个常驻 Node.js 实例每 3 秒扫描任务，最多运行两个研究包；任务租约支持进程退出后恢复。
- 浏览器 API 校验登录及项目成员关系，包括研究、文件、下载、SSE 和知识库；仅持有研究包链接不能获得访问权。MCP 保持内部凭据鉴权，默认仅监听本机。
- 登录和邀请码加入的限流为进程内实现；部署多个网页实例前需要共享限流。当前不提供密码找回、实时同屏编辑或复杂角色管理。

## 验证

```powershell
npm run lint
npm run typecheck
npm run check:model-transport
npm run check:model-config
npm run build
npm run check:search
npm run check:ddgs

# 本地 MCP 慢调用、失败停止及取消回归；包含 61 秒等待，不调用付费 API。
npm run check:agent-tools

# 需要 Next.js 已启动；验证后自动删除临时研究包。
npm run check:integration
npm run check:project-access

# 默认使用已安装的 Edge，无需安装浏览器。
npm run check:browser

# 先设置 SCENARIOFORGE_TEST_DATABASE_URL，使用独立 MySQL 测试库和本地模型/搜索夹具，不调用付费 API。
# 如果 3000 已有开发服务，可先设置 $env:AGENT_E2E_PORT="3001"。
npm run check:agent
```

其他平台可设置 `PLAYWRIGHT_CHANNEL=chrome`，或调整 Playwright 配置使用自己安装的浏览器。`check:agent`／`check:rag`／`check:rag-agent` 要求 `SCENARIOFORGE_TEST_DATABASE_URL` 指向独立 MySQL 测试库，库名必须以 `scenarioforge_test_` 开头；不要指向应用数据库。Agent 测试还需要 MCP Python 依赖，使用 `.tmp/next-agent-build`，占用本机 `AGENT_E2E_PORT`（默认 3000）、8001、9009 端口；同一套测试应顺序运行。

真实研究需要可用的模型凭据，以及一个可用的真实搜索 Provider；只有选择 tavily 时才需要 Tavily key。夹具测试使用正式 Mock Provider 验证调用链路和状态协调，不能验证服务商的模型可用性或真实研究质量。`check:integration` 预期连接以 mock 启动的 Next.js；`check:agent` 在隔离环境中强制使用 mock，不依赖本机搜索配置。

当前双页签浏览器组合回归为 `tests/plan-workflow.spec.ts`、`tests/conversation.spec.ts` 和 `tests/agent-workspace.spec.ts`，共 42/42；另五项集成用例分次通过。上传前十组离线回归合并复核 133/133（含子测试，包含方案 15 项），使用本机夹具，无真实模型调用；Windows 文件权限及符号链接部分检查仍需 Linux。独立 MySQL + 生产模式 Next.js + 网页 + 真实 Runner 验证三份文档生成、版本冻结、文件落盘及审查，独立可信 Node 测试 5/5。原始 `.tmp/` 日志和测试数据不随源码分发，可公开范围见[本版说明](docs/RELEASE_NOTES_20261111.md)和[方案流程验收报告](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)。新入口真实模型 + Docker、远程 HTTPS Runner、GitHub Agent、真实 RAG 质量和生产部署仍待验收。

## 文档

- [详细使用手册](docs/USER_MANUAL.md)
- [2026-11-11 源码更新与部署待办](docs/RELEASE_NOTES_20261111.md)
- [本地 Runner 安装与配对](docs/LOCAL_RUNNER.md)
- [工作区 Agent 与执行边界](docs/WORKSPACE_AGENT.md)
- [2026-11-11 方案生成与交接验收](docs/PLAN_WORKFLOW_VALIDATION_20261111.md)
- [2026-11-09 版本说明](docs/RELEASE_NOTES_20261109.md)
- [2026-11-09 上线记录](docs/DEPLOYMENT-20261109.md)
- [我的下一步与排序规则](docs/MY_NEXT_STEP.md)
- [个人中心](docs/PERSONAL_CENTER.md)
- [贡献记录与七级成长体系](docs/CONTRIBUTIONS.md)
- [Git 工作区功能与边界](docs/REPOSITORY_WORKSPACE.md)
- [已有内容与私有仓库导入](docs/REPOSITORY_IMPORT.md)
- [研究文档生成修复](docs/RESEARCH_GENERATION_FIX.md)
- [三个示例输入](docs/EXAMPLES.md)
- [演示脚本](docs/DEMO.md)
- [实现与开发说明](docs/DEVELOPMENT.md)
- [Ubuntu 服务器部署](deploy/README.md)
- [阶段交付与验收记录](docs/VALIDATION.md)
