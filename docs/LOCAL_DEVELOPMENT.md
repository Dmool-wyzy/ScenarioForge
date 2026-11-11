# 历史维护参考：Windows 本地开发直接使用服务器 projectdb

> **危险操作说明：**本文连接并读写服务器现有生产数据库。它不是新用户本地部署指南，也不适用于普通开发、测试或演示。请改用[独立本机数据库部署步骤](DEPLOYMENT_AND_USAGE.md#2-在-windows-本机完整部署)。只有经明确授权的维护者才可按本文操作；任何写入、迁移或测试都可能影响线上用户数据。

更新日期：2026-11-08。按用户明确要求，本地现在直接读写服务器现有数据库。

## 访问和账号

- 地址：http://localhost:3000 。使用 localhost，以匹配来源校验配置。
- 使用线上原有账号密码登录，可见项目由已有成员权限决定。
- 浏览器会话不与线上域名共享，需要在本地重新登录。
- localdev 是此前独立开发库中的账号，不属于当前 projectdb。
- 当前保存的团队和个人模型设置直接来自生产数据库，使用匹配的原加密密钥；不要重新生成该密钥。
- 本地编辑、删除、模型配置保存、任务提交都会直接影响线上数据。

## 启动和停止

```powershell
cd D:\ScenarioForge\ScenarioForge-20261108\source
.\scripts\local-dev.ps1 Start
.\scripts\local-dev.ps1 Status
.\scripts\local-dev.ps1 Stop
```

启动器后台启动数据库与 Git 接口的 SSH 隧道、Python MCP、Next.js 开发服务。重启电脑后需要重新 Start。Stop 只停止本脚本记录的本地进程，不停止服务器服务。

若系统执行策略阻止本地脚本，可仅针对本次调用运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-dev.ps1 Start
```

前端和本地 API 修改热更新；修改 Python 或 .env.local 后 Stop 再 Start。

## 数据与后台任务

```text
本地浏览器 → 本地 Next.js :3000
                → SSH 隧道 127.0.0.1:13307
                → 服务器 MySQL 127.0.0.1:3307/projectdb
线上网页   → 同一个 projectdb
服务器后台任务执行器 → 领取该库的排队任务
```

- SSH 使用 D:\ScenarioForge\java.pem，保留严格主机校验。
- 数据库连接使用现有应用账号，保留 TLS/CA 严格验证。
- 本地 .env.local 保留 localhost 来源与本地 MCP/回调地址，仅数据库凭据、配置加密密钥与模型默认配置取自服务器。
- SCENARIOFORGE_TASK_SCHEDULER=off 关闭本地队列调度。直接 npm run dev 也读取该设置；启动器在 projectdb 模式下额外强制关闭。
- 服务器继续执行排队研究、团队 Agent 任务和后台维护。本地提交任务会由服务器当前代码处理，因此修改本地后台 Agent 代码不会改变服务器队列执行逻辑。
- 同步 HTTP 请求内的逻辑（例如个人 Agent 追问）仍在接收请求的实例执行。
- 团队 Git 工作区、工作树和推送私钥保留在服务器磁盘。本地仓库接口通过 SSH 隧道 `127.0.0.1:13000 → 服务器 127.0.0.1:3000` 调用服务器现有接口，沿用用户会话、项目权限和服务器内的 Git 操作锁，不复制私钥或仓库。
- 在 `projectdb` 模式下，启动器自动设置 `SCENARIOFORGE_REPOSITORY_BACKEND_URL` 与 `SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN`。请使用启动器运行；单独执行 `npm run dev` 不会自动建立隧道或注入 Git 转发配置。独立开发库模式不启用转发。
- 转发仅允许开发模式和本机 HTTP 隧道地址。连接中断时显示重试提示，不会退回本地新建仓库或自动重试写操作。若刚提交过操作，应先重新读取仓库确认结果。
- 已有内容和私有 GitHub 仓库的导入代码及验证说明见 [REPOSITORY_IMPORT.md](REPOSITORY_IMPORT.md)。服务器 Web 已更新至 `repository-import-20261108T120734Z`，新导入动作已启用；页面根据服务器能力显示入口。
- 最新 Git 工作区版本为 `repository-workspace-20261108T124729Z`，已在前述版本基础上发布文件浏览/上传/编辑、工作分支、提交历史、审查合并和快进拉取。使用方式、限制和后续功能见 [REPOSITORY_WORKSPACE.md](REPOSITORY_WORKSPACE.md)。17 项 Git 后端测试、11 项页面测试及生产构建通过；实际登录页面已确认文件预览和历史可读。
- 本次版本的服务器回滚资料位于 `/home/ubuntu/scenarioforge/deploy/private/backups/repository-workspace-20261108T124729Z/`，保留数据库快照、源码和前一版 `.next`。无数据库迁移；回滚代码时不要直接覆盖已有新数据。

## 修改范围和迁移

本地源码可以修改，网页改动可实时查看。当前连接是真实生产库，不要运行数据库 reset、db push、migrate dev 或会清理数据的测试夹具。本次切换只读取数据库进行检查，没有运行迁移或复制数据。

若要开发 schema、队列执行器或 Git 运行逻辑，应另行准备合适的隔离测试环境，避免与线上服务同时修改同一资源。

此前独立开发库 scenarioforge_dev_admin 和开发账号均保留。原本地配置备份在 .tmp/private/isolated-dev.env；这份备份对应独立开发库，不能与当前加密密钥混用。

## 私有配置与日志

- .env.local：当前运行配置。
- .tmp/private/server.env：仅当前 Windows 用户可读的服务器配置副本。
- .tmp/private/isolated-dev.env：切换前配置备份。
- .tmp/web.out.log、web.err.log、mcp.out.log、mcp.err.log、tunnel.out.log、tunnel.err.log、repository.out.log、repository.err.log：本地服务与隧道日志。

这些配置、密钥和日志不可提交或分享。保持 .env*、.tmp/、deploy/private/ 的忽略规则。

当前运行时：Node 24.18.0、Python 3.13.5、uv 0.13.7。Python 依赖位于 mcp-server/.venv；Next.js 使用 webpack 开发模式。

## 本次切换验证

- 数据库实际名称为 projectdb，可读取 1 个已有项目和 3 个用户。
- 1 份团队模型配置、1 份个人模型配置均可使用匹配密钥解密，未展示密钥或调用模型。
- 调度开关检查通过：off 不启动本地任务定时器；默认行为仍只启动一个定时器。
- 本地首页 HTTP 200，未登录项目接口 HTTP 401。
- 本次没有数据库迁移、账号创建或数据复制。
- 已按锁文件重新安装依赖并生成 Prisma Client，完整类型检查通过。
