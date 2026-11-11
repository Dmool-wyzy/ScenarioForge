# 本地工作区 Runner

这是 2026-11-11 源码中的本地 Runner，服务器部署仍待安排。前端提供「本地工作区」和「GitHub 仓库」两种工作方式；研究文档选择、固定技能版本、任务进度和检查结果共用现有执行链路。源码版本、已通过的验证及部署待办见[本版说明](RELEASE_NOTES_20261111.md)；更新 GitHub 源码不等于线上服务已升级。

本地模式直接修改用户选择的目录。Agent 与项目模型密钥留在 ScenarioForge 服务端，Runner 从本机主动通过 HTTPS 领取文件操作，不需要开放本机入站端口，也不要求项目关联 GitHub。GitHub 模式继续在服务器的任务分支工作。

## 启用

平台维护者先在独立测试环境验证并应用迁移：

```powershell
npm run db:generate
npm run db:deploy
```

本地模式迁移为 `20261110170000_local_runner`，依赖先前的 `20261110090000_workspace_execution`；目录展示另需 `20261111120000_local_runner_directory`，只新增两个可空字段，保存连接目录与执行时目录快照。不要在未获授权的生产数据库运行迁移。本轮开发没有部署到服务器。

## 连接本机目录

1. 本机准备 Node.js 22.12+ 和此版本 ScenarioForge 源码，在源码目录执行 `npm ci`。当前 Runner 是随源码提供的命令行程序，尚未打包为独立安装程序。
2. 网页登录后，进入项目「执行工作区」页签，选择「本地工作区」。
3. 展开「连接与运行设置」→「连接新的本地目录」，填写一个名称并生成配对码。名称会显示在网页上，不要填密钥或私人路径。
4. 在本机 ScenarioForge 源码目录打开终端，复制网页命令；把示例目录替换成需要工作的实际项目目录。例如：

```powershell
node --import tsx scripts/scenarioforge-local-runner.mjs pair --url https://your-scenarioforge.example --code 网页显示的一次性配对码 --directory "D:\my-project"
node --import tsx scripts/scenarioforge-local-runner.mjs run
```

本地开发可使用 `http://localhost:3000` 或 `http://127.0.0.1:3000`。远程服务器必须使用证书受本机信任的 HTTPS，Runner 不提供跳过 TLS 校验的选项。

配对码十分钟内仅可使用一次。Runner 凭证默认有效三十天，网页可立即撤销。完整凭证保存在本机：Windows 为 `%APPDATA%\ScenarioForge\runner.json`；其他系统为 `$XDG_CONFIG_HOME/scenarioforge/runner.json`，未设置时位于 `~/.config/scenarioforge/runner.json`。不要共享或上传这个文件。默认配置保存一个连接，重新配对会替换它；请先停止旧 Runner。凭证目录必须位于选定项目目录之外。

配对时 Runner 上报实际绝对目录，已有连接重启新版 Runner 后会补报，无需重新配对。网页连接选择区展示该目录，可展开或复制；每个新任务固定启动时的目录，历史任务不会跟随连接变化。目录仅作为本人连接/任务的展示信息，不用于服务器文件访问，也不传入模型；同一 Runner 不允许更换根目录，更换须重新配对。旧任务未记录目录时明确显示未知，不从当前连接倒推。

保持终端运行，网页显示在线后选择连接和技能文件，输入要求并启动任务。按 Ctrl+C 停止 Runner；重新启动使用第二条命令即可。异常退出留下的目录锁不会被自动删除：确认所有相关 Runner 已停止后，按错误信息中的本机路径清理旧锁，再启动。

## 文件、技能和检查

- 本地文件变更立即写入选定目录，不自动创建 Git 提交、切换分支、合并或推送。用户已有未提交内容会作为执行时的当前文件读取，修改前必须读取，写入前校验整个可访问文件树版本。外部编辑导致版本变化时拒绝覆盖。
- 研究 Markdown 在创建任务时固定内容、来源、用途和版本。Agent 必须通过 `read_skill` 读取全部所选技能才能改文件；浏览或下载不影响传入。GitHub 模式还会把快照写入任务分支的 `.scenarioforge/skills/`；本地模式通过技能工具读取服务端保存的快照，不额外向用户目录写技能副本。
- 平台保存 Runner 上报的绝对目录供本人查看；文件相对路径、Agent 读取的内容、Agent 修改内容及必要的检查信息会经过 ScenarioForge 服务器和模型供应商，这不是完全离线执行。已保存的本地差异和本地执行事件只对任务创建者开放；研究对话及 GitHub 执行仍属于项目空间。浏览器快照与 SSE 都按真实任务归属过滤，本地操作事件也不进入研究模型上下文。
- 文件访问限于选定目录内的普通 UTF-8 文本。禁止路径越界、符号链接/junction、Git 内部目录、依赖和构建目录、私钥以及非示例的 `.env`。最多 300 个可访问文件，每文件最多 40,000 字符；一次最多改 20 个文件。写前还会检查回执传输预算，过大的变更需拆分任务。
- 单文件替换使用临时文件与原子 rename。多文件操作不是文件系统事务；停止、进程崩溃或外部同时编辑可能保留已完成的部分变更。停止阻止后续操作，已经送到本机的操作可能完成；请检查本机当前内容。不要让其他程序恶意并发替换目录；此实现不是操作系统沙箱。
- 同一连接只允许一个活动任务，本机目录锁阻止同一用户的第二个 Runner 同时处理相同目录。不同目录仍可由独立连接工作；当前默认 CLI 配置文件一次管理一个连接。
- 本地基线支持 JS/TS/JSON 静态语法检查。它不检查类型。Runner 默认不执行命令；用户需显式以 `run --allow-commands` 重启，并在网页逐条批准每条精确命令。
- 获批命令只会交给本机 Docker 默认上下文运行；程序拒绝远程端点，不自动下载 `node:24-alpine` 镜像，也不会在 Docker 不可用时退回宿主机执行。容器关闭网络、使用只读镜像根目录、非 root 身份和受限的临时目录，并限制 CPU、内存、进程数、运行时间与总输出。Runner 停止、授权撤销、超时或超量时会强制移除容器。
- 容器只读取 Runner 已筛出的 UTF-8 文本快照，最多 300 个文件、4 MiB；不导出 `.git`、依赖、环境文件、私钥或符号链接。命令可在容器内修改临时副本，但这些写入会被丢弃。Agent 必须通过文件变更工具修改项目。由于不挂载 `node_modules` 且容器无网络，目前只适合 Node 内置能力可完成的测试；依赖项目需要后续设计可信的离线依赖方案。
- 命令参数和输出会经过平台服务并发送给模型；网页审批前会展示完整参数和对应文件版本。仅批准你理解且愿意运行的命令。桌面目录选择与独立分发仍待后续开发，因此本地模式尚非 Codex 全功能替代。

每次最多 24 个模型回合、十分钟，最多三次启动/恢复；单次命令仍需独立批准并受 60 秒上限约束。继续使用现有项目模型配置。真实模型调用需要正常 API 额度。

## 断线与审查

任务卡的「当前步骤」和时间线按真实操作更新，包括等待模型、读取技能及版本、浏览文件、读取文件、新建/修改/删除、静态检查、命令审批、Docker 命令回执及最终差异审查。同一操作的开始与结束合并，展示实际测量耗时，展开可查看相对路径等细节；耗时包含相应工具或模型响应处理等待，不等于纯 API 延迟。复杂命令参数仅在审批卡中展示，时间线不重复内联代码或绝对路径。拒绝、超时、未执行、失败和已结束明确区分，不展示估算百分比，恢复任务不会把旧操作重新标为正在进行。旧任务原有概括事件保留，不补造操作记录。

文件命令持久化在数据库，并绑定 Runner、任务和本轮执行租约。命令先等待任务创建者审批，再绑定 Runner 单次启动授权；运行期间每两秒确认任务和连接仍有效。过期、停止、撤销或旧租约命令不可重新领取；写入不会因 HTTP 重试自动重做，回传同一领取回执可幂等确认。连接断开或操作超时时任务失败，提示检查本机是否已完成操作后再恢复。

差异记录保存每个 Agent 触及文件的初始内容及最后审查内容，并单独绑定文件快照版本。审查时重新读取本机实际内容，最终静态检查须与审查版本一致。任务完成后，网页浏览的是保存的变更快照；Runner 离线时也可查看。之后在本机自行改动不会实时更新这份历史记录。服务器不复制整个目录；正常消费和任务结束时擦除命令队列中的正文。

## 验证命令

```powershell
npm run check:local-runner
npm run check:local-runner-cli
npm run check:local-runner-commands
npm run check:workspace-agent
npm run check:workspace-agent-concurrency
npm run typecheck
node --env-file-if-exists=.env.local node_modules/@playwright/test/cli.js test tests/agent-workspace.spec.ts
```

数据库验收需显式提供独立测试库，名称必须以 `scenarioforge_test_` 开头，且两个 URL 一致；脚本不会运行迁移或真实模型：

```powershell
$env:DATABASE_URL = "mysql://test_user:password@127.0.0.1:33317/scenarioforge_test_local_runner"
$env:SCENARIOFORGE_TEST_DATABASE_URL = $env:DATABASE_URL
npm run check:local-runner-db
```

## 浏览器与 Runner 联合验收

`npm run check:local-runner-joint` 会通过真实浏览器登录、创建项目、选择技能、配对实际 CLI，并使用真实 API、后台调度、MySQL 和 Runner 修改独立测试目录。默认使用本机 HTTP 确定性模型，不调用真实模型服务；它与拦截 API 的网页夹具测试是两种不同的检查。

本轮在 Windows 与已安装的 Microsoft Edge 上验证。运行前准备已应用全部迁移的专用测试库，确保其中没有其他执行任务或排队中的研究。脚本默认启动 `127.0.0.1:3000` 的独立 Next.js 服务，端口必须空闲；可用 `SCENARIOFORGE_LOCAL_JOINT_PORT` 指定已获准使用的其他本机端口。浏览器通道默认是 `msedge`，可用 `PLAYWRIGHT_CHANNEL` 指定本机已安装的通道；脚本不会安装浏览器。

```powershell
$env:DATABASE_URL = "mysql://test_user:password@127.0.0.1:33317/scenarioforge_test_local_joint"
$env:SCENARIOFORGE_TEST_DATABASE_URL = $env:DATABASE_URL
$env:SCENARIOFORGE_LOCAL_JOINT_MODE = "fixture"
$env:SCENARIOFORGE_TEST_MODEL = $null
npm run check:local-runner-joint
```

脚本验证技能在提交时冻结为 v2，提交后源文件改为 v3 仍使用原快照；同时检查实际代码与报告落盘、无关文件保持原样、差异审查和 Runner 断线后的历史预览。验收脚本先检查生成代码只包含允许的简单算术，再独立运行五项可信测试；产品本机命令另由逐条审批和本机命令测试覆盖。

真实模型模式会读取本机 `.env.local` 中已有的模型配置。每次运行都应先取得对应模型、额度和范围的明确授权，再设置以下开关；不要为排查失败而自动重复运行：

```powershell
$env:SCENARIOFORGE_LOCAL_JOINT_MODE = "real"
$env:SCENARIOFORGE_TEST_MODEL = "1"
npm run check:local-runner-joint
```

真实模式还需要可执行的 MySQL 命令行客户端（默认 `mysql.exe`，可用 `SCENARIOFORGE_TEST_MYSQL_CLIENT` 指定完整路径），测试账号需要在该专用库创建和删除触发器的权限。脚本先自检临时触发器确实拒绝第二次 Worker 尝试，再启动网页服务；一次任务最多 24 个模型回合、十分钟，不自动恢复或重试。该触发器只存在于测试库，不改变产品默认的启动/恢复规则。

本机命令审批的浏览器夹具和真实 MySQL 测试不会调用模型；本机 Docker 上下文检查、快照挂载参数、容器回执、超时清理和命令参数传递由 `npm run check:local-runner-commands` 使用模拟 Docker CLI 离线验收。2026-11-10 后续已在本机 Docker Desktop 与 `node:24-alpine` 上完成真实命令隔离验收，且与真实模型、网页审批及 Runner 联合通过；该结果不代表远程服务器上的 Web 服务已配置 Docker 权限或完成远程 Runner 配对。

结果保存在 `.tmp/local-joint-fixture-*` 或 `.tmp/local-joint-real-*`：包括脱敏 `report.json`、Web/Runner 日志、测试文件，成功时还有完成页面截图。脚本停止自身浏览器与子进程，删除测试业务记录、临时触发器及本轮 Runner 凭证；提供测试库和 MySQL 实例的维护者仍须负责最终关闭与删除临时数据库环境。真实模型失败也可能产生 API 消耗，报告没有用量统计时不能记作零。

2026-11-10 的本机真实模型、网页、Runner 与 Docker 联合验收已通过：一次任务、一次 Worker 尝试、仅批准 `node --test tests/calc.test.mjs`，五项测试通过。更早两次真实模型任务失败的记录仍保留为历史，不应与这次成功结果混淆。测试使用预置技能，未覆盖研究完成后自动派发编码任务；远程服务器配对与部署仍待验收。详情见[验收记录](WORKSPACE_AGENT_VALIDATION_20261110.md)。
