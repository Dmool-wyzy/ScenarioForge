# ScenarioForge 本地与服务器部署使用手册

本手册面向第一次接触 ScenarioForge 的使用者和部署者。先选择你要做的事：

| 目标 | 你需要准备什么 | 说明 |
| --- | --- | --- |
| 直接使用别人已经部署的网站 | 浏览器、账号 | 不需要克隆代码，也不需要在自己的电脑安装 Docker。 |
| 在自己的电脑完整运行 ScenarioForge | 源码、Node.js、Python/uv、独立 MySQL | 网页、API、MCP 和数据库都由你自己运行。 |
| 在自己的服务器部署网站 | Linux 服务器、HTTPS、MySQL、Node.js、Python/uv、反向代理 | 服务器运行网页和 Agent 服务；需要时另用本地 Runner 访问个人电脑目录。 |
| 让已部署的网站 Agent 修改自己电脑上的项目 | 网站账号、Node.js、ScenarioForge 源码和本地项目目录 | 只在本机运行 Runner，不必在本机另部署整个平台。 |

“本地部署”和“本地工作区”不是同一件事。完整本地部署会在本机运行整个平台；本地工作区模式只在本机运行 Runner，将指定目录连接到一个已经运行的 ScenarioForge 网站。

## 1. 部署前准备

### 源码和运行时

从官方源码仓库获取项目：

```text
https://github.com/Dmool-wyzy/ScenarioForge
```

当前项目要求 Node.js 22.12 或更高版本、Python 3.11 或更高版本、Git 和 `uv`。部署在 Windows 时，以下本地命令以 PowerShell 为例；Ubuntu 服务端命令和现有服务器的具体配置见 [Ubuntu 部署运维手册](../deploy/README.md)。

Docker 不是运行网页、数据库或 Runner 文件读写的必需品。只有启用 Runner 的命令执行检查时，才需要本机 Docker Desktop 或 Linux Docker Engine，以及项目要求的镜像。命令不会因 Docker 缺失而退回宿主机执行。

### 数据库

当前版本使用 MySQL 8.4。新安装请创建专用数据库和最小权限账号，不要连接开发者个人数据库或其他实例的生产库。数据库连接使用 TLS 和可信 CA 证书；不要为了让连接成功而关闭证书校验。数据库密码写入 `DATABASE_URL` 前，应对 URL 保留字符进行百分号编码。

本仓库的 `compose.yaml` 只启动反向代理，不包含 ScenarioForge、MySQL 或 Python MCP。不要把它当成完整的一键部署栈。

### 模型、搜索和 RAG

- 可先部署并登录，再配置模型。项目创建者可在项目设置里保存模型 API 地址、密钥、模型 ID 和协议。API 密钥由服务端加密保存；不要放进网页源码、`NEXT_PUBLIC_` 环境变量、Runner 命令或项目 Git 仓库。
- “基础连接”“工具调用”“结构化输出”是不同能力，分别测试。基础连接通过不代表文档生成或 Agent 工具调用可用。测试会发送请求并可能产生费用。
- 默认 `SEARCH_PROVIDER=mock`，返回值是测试数据，不可当作真实研究证据。要进行真实联网研究，需由平台管理员配置并验证真实 Search Provider。
- 默认 `RAG_ENABLED=false`。RAG 需要独立 Embedding 地址、密钥、模型和维度等配置；它与聊天模型配置彼此独立。先阅读 [RAG 配置说明](RAG.md)，再在独立资料集上测试召回和引用，不要默认认为已启用语义检索。

## 2. 在 Windows 本机完整部署

这个方式会在自己的电脑运行网页、API、后台任务和 MCP 服务。请为 ScenarioForge 准备一个独立 MySQL 数据库；不要把 `.env.local` 配到服务器生产数据库。

### 第一步：安装并检查依赖

安装 Node.js 22.12+、Python 3.11+、Git、`uv` 和 MySQL 8.4。确认 PowerShell 可找到它们：

```powershell
node --version
npm --version
python --version
git --version
uv --version
```

如果没有 `uv`，可运行：

```powershell
python -m pip install uv
```

MySQL 准备好后，记下数据库地址、端口、数据库名、专用用户名、密码和可信 CA 证书绝对路径。确保本机 MySQL 只允许本机或可信内网访问。

使用本机 MySQL 管理员账号连接后，为应用建立独立库和账号。将示例密码替换为新的强密码；这里账号限定为 TCP 回环地址 `127.0.0.1`，需与下面连接串中的主机一致：

```sql
CREATE DATABASE scenarioforge CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'scenarioforge'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT ALL PRIVILEGES ON scenarioforge.* TO 'scenarioforge'@'127.0.0.1';
```

确认 MySQL 服务端已启用 TLS，并从该服务端管理员处取得其 CA 证书（例如初始化时生成的 `ca.pem`）。只复制 CA 公共证书，不复制服务器私钥。先用 MySQL 客户端验证证书和账号：

```powershell
mysql --host=127.0.0.1 --port=3306 --user=scenarioforge --password `
  --ssl-mode=VERIFY_CA --ssl-ca="C:/private/mysql-ca.pem" scenarioforge
```

只有通过 `VERIFY_CA` 验证后，才把同一 CA 路径填入 `DATABASE_URL`。如果你无法安全配置本机 MySQL TLS，可使用已启用 TLS 且提供 CA 的托管 MySQL；不要通过关闭证书验证绕过错误。

### 第二步：克隆项目并安装依赖

```powershell
git clone https://github.com/Dmool-wyzy/ScenarioForge.git
Set-Location ScenarioForge
npm ci
Copy-Item .env.example .env.local
Set-Location mcp-server
uv sync --locked
Set-Location ..
```

不要提交 `.env.local`、密钥、数据库文件、`node_modules`、缓存或运行日志。`.env.example` 是可共享的配置模板。

### 第三步：配置 `.env.local`

用编辑器打开项目根目录 `.env.local`，至少填写以下设置。占位符要替换成你自己的值：

```env
DATABASE_URL="mysql://scenarioforge:URL编码后的数据库密码@127.0.0.1:3306/scenarioforge?sslcert=C:/private/mysql-ca.pem&sslaccept=strict"
SCENARIOFORGE_PUBLIC_ORIGIN=http://localhost:3000
SCENARIOFORGE_INTERNAL_TOKEN=替换成随机生成的长令牌
SCENARIOFORGE_SETTINGS_KEY=替换成随机生成的base64密钥
SCENARIOFORGE_MCP_URL=http://localhost:8000/mcp
SCENARIOFORGE_BACKEND_URL=http://localhost:3000
SEARCH_PROVIDER=mock
RAG_ENABLED=false
```

`DATABASE_URL` 里的 CA 路径必须换成 MySQL 实际签发链的可信 CA 文件绝对路径。Windows 路径可用正斜杠，例如 `C:/ScenarioForge/private/mysql-ca.pem`。账号密码中的 `@`、`:`、`/`、`#` 等保留字符要进行 URL 编码。

生成两个服务共用的内部令牌和服务端加密密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

第一条结果填入 `SCENARIOFORGE_INTERNAL_TOKEN`；第二条结果填入 `SCENARIOFORGE_SETTINGS_KEY`。后者必须是 32 字节随机数据的 Base64 编码。将加密密钥另行备份在安全位置；密钥丢失会导致已保存的模型设置不可解密，更换密钥也不能直接恢复旧设置。

本地访问地址要与 `SCENARIOFORGE_PUBLIC_ORIGIN` 完全一致，包括协议、主机和端口。默认用 `http://localhost:3000`，不要配置成 `127.0.0.1` 后又从 `localhost` 访问。生产环境必须使用 HTTPS。

初次部署可以保持空模型凭据、`SEARCH_PROVIDER=mock` 和 `RAG_ENABLED=false`，先验证账号、项目与页面，再在项目设置里配置模型。也可以在服务端环境中提供 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_API_MODE` 和 `SCENARIOFORGE_MODEL` 作为默认模型；已保存的项目配置优先。模型协议须按实际服务商支持情况选择。

### 第四步：初始化数据库

在项目根目录运行：

```powershell
npm run db:generate
npm run db:deploy
```

首次部署使用已提交的 Prisma MySQL 迁移。生产升级也只能在备份后使用 `db:deploy` 应用已提交迁移。不要对包含真实数据的数据库运行 `db:migrate`、`db push`、数据库重置或测试夹具。

### 第五步：启动网页和 MCP

开两个 PowerShell 窗口，并保持它们运行。

窗口一：

```powershell
Set-Location D:\path\to\ScenarioForge\mcp-server
uv run main.py
```

窗口二：

```powershell
Set-Location D:\path\to\ScenarioForge
npm run dev
```

浏览器访问 <http://localhost:3000>。停止服务时在对应窗口按 `Ctrl+C`。修改 `.env.local` 后重启两个服务。

### 第六步：创建账号并验证

1. 注册账号并登录，创建一个测试项目。
2. 在项目模型设置中保存 API 地址、API Key、模型 ID 和协议；分别运行基础连接、工具调用、结构化输出测试。保存与测试是独立操作。
3. 首次验证先使用不含敏感资料的小任务。若 Search Provider 仍是 `mock`，不要把来源当作真实证据。
4. 确认文档清单后生成 Markdown，再检查、编辑并保存文件。保存的 Markdown 可以在创建 Agent 任务时作为技能传入。
5. 将工作区模式选为 GitHub 或本地工作区后，检查任务目标、技能和目录，再手动启动。Agent 修改项目不代表已审查或合并。

要把 Agent 连接到本机项目目录，请按“本地 Runner”一节操作。Runner 可以连接 `localhost` 上的本地平台，也可以连接远程 HTTPS 网站；它必须在需要被修改的那台电脑上运行。

## 3. 部署到自己的服务器

生产部署会让用户通过公网访问服务。上线前先准备域名或公网 HTTPS 地址、Linux 主机、MySQL 8.4、TLS CA、可信反向代理和备份方案。建议使用专用 Linux 用户运行应用；数据库和 MCP 不要直接暴露公网。

### 网络与服务拓扑

```text
浏览器 --HTTPS--> 反向代理 --回环 HTTP--> Next.js :3000
                                      |--> MySQL（私网/回环，TLS）
                                      `--> Python MCP :8000（回环）

用户电脑 --主动 HTTPS 长连接--> ScenarioForge Runner API
```

公网只开放 HTTPS 入口（通常 TCP 443；签发或续期证书可能还需要 TCP 80）。Next.js 和 MCP 仅监听 `127.0.0.1` 或受控私网；MySQL 不开放公网。反向代理必须正确处理 HTTPS 来源头、长连接/SSE、上传大小和超时。

### 上线步骤

1. **准备主机与域名。** 更新系统补丁，配置防火墙和云安全组。将域名指向服务器；若使用 IP 地址，确认证书颁发机构支持该 IP，并核实证书期限及自动续期机制。
2. **准备 MySQL。** 创建专用数据库和应用账号，使用 TLS。备份数据库及可信 CA；限制数据库账号只访问 ScenarioForge 数据库。
3. **获取源码并固定版本。** 克隆仓库或部署经过审查的发布包，记录 Git commit。不要将开发机的 `.env.local`、`java.pem`、Runner 凭据或 `.tmp/` 上传到服务器。
4. **安装受支持运行时。** 安装 Node.js 22.12+、Python 3.11+、`uv`、Git 和构建工具；在项目根目录运行 `npm ci`，在 `mcp-server` 目录运行 `uv sync --locked --no-dev`。
5. **创建服务器私有配置。** 创建权限受限的环境文件，例如部署目录下只允许服务用户读取的 `deploy/private/.env.local`，并配置：

   ```env
   NODE_ENV=production
   SCENARIOFORGE_PUBLIC_ORIGIN=https://scenarioforge.example
   DATABASE_URL="mysql://scenarioforge:URL编码后的密码@127.0.0.1:3306/scenarioforge?sslcert=/etc/scenarioforge/mysql-ca.pem&sslaccept=strict"
   SCENARIOFORGE_INTERNAL_TOKEN=至少32字符的随机令牌
   SCENARIOFORGE_SETTINGS_KEY=32字节随机数据的base64编码
   SCENARIOFORGE_MCP_URL=http://127.0.0.1:8000/mcp
   SCENARIOFORGE_BACKEND_URL=http://127.0.0.1:3000
   SEARCH_PROVIDER=mock
   RAG_ENABLED=false
   ```

   令牌和加密密钥使用不同的随机值；密钥生成方法见本地配置一节。若服务器提供模型默认值，再填写 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_API_MODE` 和 `SCENARIOFORGE_MODEL`。不要把此文件放进 Git、systemd 命令行参数或反向代理公开目录。
6. **验证数据库迁移。** 先在隔离库对这次发布运行 `npm run db:generate`、`npm run db:deploy` 和项目测试。生产升级前做可恢复的数据库快照；再用生产配置执行 `npm run db:generate` 和 `npm run db:deploy`。切勿在生产运行 `migrate dev` 或 `db push`。
7. **构建生产版本。** 使用 `npm run build` 生成 Next.js 构建。资源有限的主机应在隔离的发布目录构建，限制构建资源；确认新构建可用后再切换，不在当前在线构建目录里覆盖 `.next`。
8. **配置常驻服务。** 用 systemd 或等效服务管理器启动 Next.js `npm run start -- --hostname 127.0.0.1` 与 Python MCP `uv run main.py`，配置开机启动、自动恢复和受限服务账号。MCP 默认只监听回环地址。MCP 和网页进程读取同一份受保护配置。
9. **配置反向代理和 HTTPS。** 使用团队信任的 Nginx/Caddy 等反向代理，校验证书自动续期、SSE、请求来源和上传限制。检查 `SCENARIOFORGE_PUBLIC_ORIGIN` 与用户实际访问 URL 完全一致。
10. **验收并记录回滚点。** 检查首页、注册/登录、创建项目、模型配置保存/测试、研究文档生成、文件下载、Agent 工作区和 Runner 配对。先用测试账号和空项目，不要在没有备份时导入真实资料。记录源码 commit、迁移状态、数据库快照、配置备份位置和上一个可恢复构建。

服务器章节提供通用拓扑和上线检查顺序；对一台全新服务器，它仍需按实际系统、域名、数据库和代理补齐服务安装配置。本仓库的 [Ubuntu 部署运维手册](../deploy/README.md) 是现有实例的详细操作 runbook，不是通用安装器：它假设 `ubuntu` 用户、`/home/ubuntu/scenarioforge` 路径、MySQL `127.0.0.1:3307`、已缓存的代理镜像以及当前公网 IP 证书配置。给朋友部署时，必须按自己的域名、数据库、证书、系统用户和代理镜像逐项调整，并先审核镜像来源；不要照抄现有服务器的 IP、路径、私有配置或固定发布脚本。

当前部署脚本不自动创建和备份 MySQL 数据库。管理员需自行安排数据库备份、加密密钥备份、恢复演练、补丁更新和告警。数据库备份与 `SCENARIOFORGE_SETTINGS_KEY` 应分开保存在访问受限的位置。多实例横向扩容还需要共享限流与任务协调方案；当前按单 Web 实例部署。

## 4. 连接本机工作区 Runner

本地 Runner 适用于“平台已在服务器运行，但我想让 Agent 操作自己电脑上的目录”。这不会把网站或数据库部署到你的电脑，也不会在服务器上创建本机项目副本。

1. 在**需要被修改的电脑**安装 Node.js 22.12+，克隆与网站兼容版本的 ScenarioForge 源码，并运行 `npm ci`。
2. 登录网站，打开项目的「执行工作区」，选择「本地工作区」并展开「连接与运行设置」。点击「连接新的本地目录」，输入连接名称并生成一次性配对码。
3. 在本机 ScenarioForge 源码目录打开终端，把网页生成命令里的目录替换成真实项目目录。示例：

   ```powershell
   node --import tsx scripts/scenarioforge-local-runner.mjs pair --url https://your-scenarioforge.example --code ONE_TIME_CODE --directory "D:\my-project"
   node --import tsx scripts/scenarioforge-local-runner.mjs run
   ```

   `ONE_TIME_CODE` 仅能配对一次，约十分钟有效。使用服务器时必须使用网页所对应站点的 HTTPS 地址；不要关闭 TLS 校验或把配对码发给别人。
4. 保持 Runner 终端运行，等网页显示连接在线。连接后核对网页显示的绝对目录，再选择技能、输入任务并手动开始。
5. Agent 会直接修改所选目录中的有限范围文本文件，不会自动创建 Git 提交、合并或推送。开始前先提交或备份你的改动，结束后查看差异并自行运行项目测试。

默认 Runner 凭据保存在 Windows `%APPDATA%\ScenarioForge\runner.json`，不要共享或上传。网页可以撤销连接；默认配置一次保存一个 Runner 连接。完整文件边界、命令审批、Docker 隔离及并发限制见[本地 Runner 安全与运行说明](LOCAL_RUNNER.md)。

Runner 文件访问、差异和必要的检查信息会经过 ScenarioForge 服务器，相关模型请求还会发送给模型供应商。选择目录前移除不想上传给服务端或模型的文件，并检查 Agent 任务中的技能与指令。

## 5. 日常使用

1. **账号和项目：**注册/登录后创建项目，或使用邀请码加入已有项目。研究资料和项目模型设置按项目权限隔离。
2. **配置模型：**项目创建者在模型设置里选择服务商、API Base URL、密钥、模型 ID 与 API 协议，保存后分别测试基础文本、工具调用和结构化输出。不要因为某项连接通过就假定其他能力也可用。
3. **选择本次操作：**「生成方案」会先显示可编辑的 Markdown 清单；预览不调用模型。确认清单后才会调用模型生成正文。选择「仅讨论」则用于对话，不会自动创建文件。
4. **整理研究文档：**检查来源和内容，按需编辑并保存。下载 Markdown 或 ZIP 是可选操作；下载本身不会把文件交给 Runner。
5. **把文档作为技能：**启动工作区任务前选择已保存的研究文档。任务会固定当时的文档内容和版本，Agent 需读取所选技能后才能修改工作区。
6. **选择执行位置：**本地工作区会通过在线 Runner 修改你电脑的连接目录；GitHub 仓库模式在服务端任务分支工作。两者都需要在网页手动开始，Agent 不会自动推送或合并到 GitHub。
7. **审查结果：**检查任务进度、文件差异和最终状态。若任务使用本机命令，必须在网页逐条批准准确命令；拒绝或超时不会执行。获批命令由 Docker 容器验证，容器无网络，容器内文件改动会丢弃。

研究文档不是已核实事实，也不是测试通过证明。联网搜索、模型输出和代码变更都要由使用者自行审查。需要团队复用的研究成果应显式共享；不要把未审查内容当作权威知识。

## 6. 故障排查

| 现象 | 检查项 |
| --- | --- |
| 网页无法打开 | 检查 Next.js 服务状态、`npm run dev` 或 `npm run start -- --hostname 127.0.0.1` 日志、端口占用及反向代理状态。 |
| 页面报服务端配置错误 | 确认数据库可连、迁移已应用、`.env.local` 可读、内部令牌在 Node/MCP 两服务一致；修改后重启服务。不要把密钥贴进错误报告。 |
| 模型连接超时或失败 | 核对 API Base URL、网络/VPN、模型 ID、密钥、协议及超时；分别查看失败的能力测试项和 HTTP 状态。系统不会自动切换协议或自动重试。 |
| 能聊天但不能生成方案 | 检查当前 API 协议是否支持严格结构化输出，运行结构化输出测试。基础连接通过只说明最小文本请求成功。 |
| 搜索结果显示 Mock | 管理员尚未启用真实 Search Provider。Mock 只供测试，不是互联网搜索证据。 |
| RAG 未检索到内容 | 确认 `RAG_ENABLED`、独立 Embedding 地址/密钥/模型/维度、索引状态和分块设置；修改 Embedding 或切块参数后按 [RAG 说明](RAG.md)重建索引。 |
| Runner 显示离线 | 检查运行 Runner 的终端是否仍打开、网站地址/TLS 是否可信、配对码是否过期、连接是否被撤销。远程 HTTPS 不能跳过证书验证。 |
| Agent 未修改文件或提示路径不可用 | 核对网页显示的 Runner 目录和任务启动时目录；受保护文件、符号链接、依赖目录、Git 内部目录和非 UTF-8 文本不在可操作范围。 |
| 命令无法执行 | 检查 Runner 是否以 `run --allow-commands` 启动、Docker 默认本地上下文是否可用、所需镜像是否已下载，并确认网页逐条批准了命令。不会退回宿主机执行。 |

## 7. 更新、备份与卸载

### 更新源码

先读取对应发布说明和迁移记录，备份数据库与私有配置，确认没有执行中的研究或 Agent 任务。拉取目标版本后使用锁文件安装依赖，再按发布步骤构建、应用迁移并重启服务。生产只使用 `npm run db:deploy`；不要在旧代码仍运行时覆盖依赖或 `.next`。保留上一个可恢复构建和数据库备份，部署失败时先恢复代码，数据库回退必须单独评估用户新数据影响。

由于现有服务器有特定资源限制、私有目录和代理设置，真实线上更新请使用[Ubuntu runbook 的版本更新章节](../deploy/README.md#5-检查和更新)，不可直接照抄旧发布脚本或在生产目录运行无资源限制的构建。

### 备份

至少分别备份：MySQL 数据库、`SCENARIOFORGE_SETTINGS_KEY`、私有环境配置、GitHub 私有仓库/凭据（若使用）。加密密钥丢失可能使数据库中模型配置不可读。将备份放到权限受限的位置，并定期实际演练恢复。

### 本地卸载

先停止网页和 MCP 进程，再确认是否要保留 MySQL 数据。删除克隆源码不会删除独立安装的 MySQL；清除数据库会永久删除账号、项目、文档和设置，请先另存备份。Runner 凭据位于 `%APPDATA%\ScenarioForge\runner.json`，卸载连接前可在网页撤销。

## 8. 相关文档

- [产品功能详细使用手册](USER_MANUAL.md)
- [本地 Runner 完整安全与限制](LOCAL_RUNNER.md)
- [Ubuntu 单机部署运维手册](../deploy/README.md)
- [开发环境和架构说明](DEVELOPMENT.md)
- [RAG 与 Embedding 配置](RAG.md)
- [模型执行参数](MODEL_EXECUTION_POLICY_20261111.md)
- [当前版本交付与待办](HANDOVER.md)
