# 2026-11-11 工作区 Agent 上线记录

工作区 Agent、本地 Runner、可编辑文档清单、目录与操作进度、双页签界面已部署至 [ScenarioForge](https://175.27.143.14/)。此次完成应用和迁移发布，以及无模型的服务器与公网验收；新入口的真实模型、实际电脑 Runner 和完整 GitHub Agent 链路仍待专项验收。[2026-11-09 上线记录](DEPLOYMENT-20261109.md)保留供历史追溯。

## 发布版本

| 项目 | 本次记录 |
| --- | --- |
| 发布标识 | `workspace-agent-20261111-662e5ed` |
| 代码提交 | `662e5ed6bc066245e88314954ded62cb98908aa3` |
| 公网入口 | `https://175.27.143.14/` |
| Next.js BUILD_ID | `Zwkz6k8STTt7AjaAP6_-b` |
| 切换时间 | 2026-11-11 05:49:45.031 UTC；北京时间 13:49:45 |
| 无模型公网验收 | 2026-11-11 05:50:02 UTC；北京时间 13:50:02 |
| 最终只读核验 | 2026-11-11 05:51:23 UTC；北京时间 13:51:23 |
| 源码归档 | 约 2.99 MB，不含配置、凭据、依赖、构建或临时工作区 |
| 归档 SHA-256 | `58b8be6d00a8cff10898e137c5c1de5a170f0d26679fcaaff907ff3cb7013e41` |

## 发布过程与配置

在独立源码目录执行锁文件依赖安装和 Prisma Client 生成，不修改旧站的共享依赖；使用临时 systemd 单元将构建限制在 4G 内存、200% CPU、600 秒以内，webpack 生产构建成功。切换前保留数据库和应用回滚资料，再整体切换源码、匹配依赖和完整 `.next` 构建。

生产库由 11 条迁移升级至 14 条，新增迁移均已成功应用：

1. `20261110090000_workspace_execution`：执行任务、技能快照、租约和验证记录。
2. `20261110170000_local_runner`：Runner 配对与文件/命令队列，以及本地执行目标。
3. `20261111120000_local_runner_directory`：Runner 目录与执行时目录快照。

生产 `.env.local`、`SCENARIOFORGE_SETTINGS_KEY` 和既有模型等私有配置保持原值，最终核对环境文件哈希与部署前一致；未上传本地开发配置。MCP 未重启。Web、MCP、MySQL 的监听地址和公网入口沿用原部署方式。

Web 新增 `/etc/systemd/system/scenarioforge-web.service.d/workspace-execution.conf`：

```ini
[Service]
SupplementaryGroups=docker
Environment=SCENARIOFORGE_EXECUTION_EXPORT_ROOT=/home/ubuntu/scenarioforge/deploy/private/execution-exports
```

该 drop-in 为服务器工作区容器验证提供 Docker 权限和双方可见的快照目录，保留原服务的 `PrivateTmp` 等设置。最终核对运行中 Web 主进程的补充组包含 Docker 组；导出目录属于服务用户、权限为 0700，验收结束后为空。此项配置用于服务器仓库模式；用户电脑上的本地命令仍由该电脑的 Runner 与 Docker 执行。

## 验证结果

| 检查 | 实测结果与范围 |
| --- | --- |
| Linux 离线组合 | 133/133（含子测试），使用夹具，无真实模型调用；同组此前也在 Windows 上通过，数量不重复相加 |
| 独立 MySQL | 19/19，14 条迁移验收通过；测试库 `scenarioforge_test_release_20261111` 和账号 `sf_release_20261111` 已删除 |
| 真实 Docker | 1/1，错误加法实现测试失败，修复后通过；容器隔离断言通过，无模型调用 |
| 生产迁移 | 新增三条成功应用，共 14 条有效迁移 |
| 公网首页与资源 | 首页正常，11 项引用静态资源均正常；客户端包含双页签与研究两栏资源 |
| 注册、登录与退出 | 使用新建的独立验收账号；生产 Secure Cookie、登录会话轮换和登出通过 |
| 文档预览 | 通过 `mode: documents` 创建清单，再调用 `action: preview`；返回 `PLAN.md`、`TASKS.md`，状态保持 `documents_plan_ready` / `idle`，没有生成正文、保存文件或排队模型/Embedding/执行任务 |
| Runner HTTPS API | 直接 API 客户端完成单次码配对、目录上报与在线心跳；重复使用配对码被拒绝，改绑目录被拒绝，撤销后旧令牌返回 401 |
| 公网访问控制 | 八项未登录 API 返回 401，`/api/internal/deployment-check` 返回 404 |
| 运行状态 | Web、MCP、MySQL 与证书续期 timer 均为 active；生产配置哈希一致，导出目录为空，独立验收库和账号不存在 |
| 临时数据 | 公网验收用户、项目、研究包、Runner 均已按本次创建的 ID 清理；配对凭据仅保存在验收进程内存中 |

公网 Runner 测试没有启动 CLI，也没有连接或修改用户电脑目录。两栏与页签检查只验证发布的静态资源存在；本次未在生产站进行浏览器渲染、切换或编辑等交互验收。此前本机浏览器组合 42/42 与模型夹具联合验收的范围见[方案与交接报告](PLAN_WORKFLOW_VALIDATION_20261111.md)。

此次没有真实模型调用、文档正文生成或 Agent 编码任务，也没有完成从真实 GitHub 仓库到人工合并/推送的完整流程。真实 Docker 成功证明本次容器验证路径可用，不能替代真实模型从清单生成到技能交接、修改、测试与人工审查的全链路验收。2026-11-10 的真实模型成功记录使用预置技能，见[此前验收](WORKSPACE_AGENT_VALIDATION_20261110.md)。

## 备份、回滚与日志

| 资料 | 服务器位置 |
| --- | --- |
| 当前应用 | `/home/ubuntu/scenarioforge` |
| 本次发布资料与日志 | `/home/ubuntu/scenarioforge-release-workspace-agent-20261111-662e5ed` |
| 本次私有备份 | `/home/ubuntu/scenarioforge/deploy/private/backups/workspace-agent-20261111-662e5ed` |
| 上一构建 | `/home/ubuntu/scenarioforge/.next-before-workspace-agent-20261111-662e5ed` |
| 上一依赖 | `/home/ubuntu/scenarioforge/node_modules-before-workspace-agent-20261111-662e5ed` |
| 当前容器快照导出目录 | `/home/ubuntu/scenarioforge/deploy/private/execution-exports` |

回滚应恢复匹配的源码、依赖和构建，保留原私有配置；不要用发布前数据库转储覆盖上线后的用户写入。本次迁移增加表和可空元数据，回滚旧应用时不应顺带删除新表或字段。数据库恢复与异机重装仍未完成演练，备份资料不得当作可随意删除的临时文件。

私有备份、验收日志与凭据不加入 GitHub。源码归档和本记录保留可核对的版本及范围；原开发机 `.tmp/` 路径不是新环境的运行依赖。

## 证书、磁盘与后续验收

可信 HTTPS 已通过实际请求验证。此次检查的证书有效期为 2026-11-10 03:33:10 UTC 至 2026-11-16 19:33:09 UTC，北京时间到期为 11 月 17 日 03:33:09；续期 timer 为 active，检查时下次触发为北京时间 11 月 12 日 00:41:44。IP 证书有效期较短，后续以实际证书与 timer 状态为准，保持原续期入口可用。

最终 `/dev/vda2` 磁盘记录：总计 59G、已用 53G、可用约 4.0G、使用率 93%。下次安装依赖、构建或备份前重新检查可用空间，保留当前与上一版本的有效回滚资料。

后续按以下范围继续验收和开发：

1. 经单独授权，完成新入口真实模型生成文档 → 技能交接 → 工作区修改 → Docker → 人工审查。
2. 从线上 HTTPS 项目配对实际电脑上的 Runner CLI，验证真实目录、文件修改、逐条命令审批、断线与恢复。本次直接 API 客户端验收未覆盖这一部分。
3. 完成真实 GitHub 仓库的 Agent 任务分支、验证、人工合并和推送流程；已有仓库管理与容器能力不等于完整链路已验收。
4. 保留现有待办：Runner 安装与分发、依赖安装/缓存、多语言和较大工程、费用硬预算、多进程协调、自动备份及恢复演练。生产 `RAG_ENABLED=false`，独立 Embedding 与 RAG 质量仍待配置验收。
