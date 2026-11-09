# 团队 Git 仓库导入

## 使用流程

1. 进入 ScenarioForge 项目，展开“团队 Git 工作区”。填写 GitHub HTTPS 仓库地址；分支留空时识别远程默认分支，也可以指定 `main`、`master`、`release/v1` 等。
2. 点击“生成部署公钥”，在该 GitHub 仓库的 Settings → Deploy keys 中添加公钥。只读部署密钥即可导入；需要推送交付时开启 Allow write access。私有仓库不需要提供个人访问令牌。
3. 点击“验证授权并导入”。导入选定分支的文件和可达提交历史；空仓库会创建初始 README。导入后，本地工作分支统一为 main，检查和推送仍指向选择的远程分支。
4. 使用项目页面右上角的邀请码邀请成员；Git 展开页不重复提供邀请入口。成员登录后加入项目。GitHub 的直接访问权限仍由仓库管理员单独配置。导入的私有仓库内容属于项目共同工作区。
5. 成员交付保存到任务分支，创建者查看差异后合并。推送有独立确认步骤，使用普通推送，不强制覆盖远程分叉。

尚未建立 Git 工作区的项目、以及仅包含系统初始化 README 的未修改工作区均可导入。后一种情况在切换前再次验证原提交、文件、分支和工作树，并将原目录保存到 `backups/<projectId>/before-import-*/repository`。已有自定义文件、团队交付或远程连接的工作区不会覆盖；这类项目应另建项目导入。每个项目绑定一个仓库，当前没有更换远程地址、自动拉取后续远程提交或冲突编辑功能。

Git LFS 和子模块只保留仓库中的引用，不自动下载关联对象。导入不会安装依赖、运行项目代码或 Git hooks。远程 Git 命令有 45 秒时限，过大的仓库可能需要缩小导入范围或另行导入；当前没有浅克隆选项。

## 实现和兼容

- `prepare` 保存项目独立的连接信息并生成部署密钥；`import` 在临时目录完成 fetch/checkout，确认成功后才移动为项目工作区。
- 元数据保存在 `credentials/<projectId>/connection.json`；远程目标分支另存入仓库 config 的 `scenarioforge.remoteBranch`。旧仓库默认使用 main，无 schema 变更或数据库迁移。
- API 沿用项目成员验证与创建者权限。部署公钥仅返回创建者；私钥始终保留在运行 Git 接口的主机上。所有 Git 写操作仍由同一个 Web 进程串行管理。
- 失败导入清理本次临时目录、保留公钥以便重试；导入完成后重试不会重置工作区。交付操作拒绝覆盖导入仓库已有同名文件，拒绝把 deliveries 符号链接当作目录写入。
- GET 返回 `capabilities.import=true` 后，界面才启用新导入流程。旧服务器仍显示兼容的公开空仓库入口和待更新提示，避免向旧 API 发送不支持的动作。

## 当前部署边界

本地网页已更新；连接 projectdb 时，Git API 通过 SSH 转发到现有服务器。因此，仅修改本地源码不足以启用真实仓库导入，需要按 `deploy/README.md` 的独立构建和回滚流程更新服务器 Web 服务。已于 2026-11-08 发布至当前服务器，发布标识为 `repository-import-20261108T120734Z`。

服务端更新必需文件：`lib/repository.ts`、`lib/repository-backend.ts`、`app/api/projects/[id]/repository/route.ts`。线上若也要使用相同表单，同时更新 `app/components/ProjectRepository.tsx` 及其调用方 `app/page.tsx`。部署时应对比线上源码，只应用这些改动，不上传本机 `.env.local`、密钥或测试目录。

发布前检查当前服务、可用空间与活动任务，保留原源码与构建，使用资源受限的独立构建；切换需要短暂重启 Web。数据库、MCP 服务、已有仓库及部署密钥均无需迁移。本次发布已执行独立构建、活动任务检查、数据库与源码备份，并短暂切换 Web；首页、鉴权边界和本地已登录页面均通过验证。

## 验证

```powershell
npm run typecheck
node node_modules/eslint/bin/eslint.js app/components/ProjectRepository.tsx lib/repository.ts lib/repository-backend.ts 'app/api/projects/[id]/repository/route.ts' scripts/check-repository-import.ts tests/project-repository.spec.ts tests/personal-agent.spec.ts
node --conditions=react-server --import tsx --test scripts/check-repository.ts scripts/check-repository-import.ts scripts/check-repository-backend.ts
node node_modules/@playwright/test/cli.js test tests/project-repository.spec.ts tests/personal-agent.spec.ts
```

Git 测试使用临时目录及本地远程仓库，并模拟部署密钥授权失败；浏览器测试拦截全部 API。均不创建真实 GitHub 仓库、调用真实私有仓库或修改 projectdb 的项目数据。真实 GitHub 私有仓库授权需要由仓库管理员在部署后完成。

## 2026-11-08 修复与发布记录

- 修复本地页面已更新、服务器仓库接口仍为旧版导致的“仅支持空仓库”错误。
- 移除 Git 展开页中的重复邀请区域，保留页面右上角原有入口。
- 支持在仅有初始化 README 的现有工作区内导入；失败时保留原工作区，成功时保留完整备份。
- Windows 本地：类型检查、针对改动文件的 ESLint、12 项 Git 测试和 8 项浏览器测试通过。Linux 服务器隔离构建及同组 12 项 Git 测试通过。
- 实际已登录页面中“开发测试”项目显示“生成部署公钥”，分支输入可用，无旧版能力提示和重复邀请区域。此验证未创建项目部署密钥或导入、推送用户仓库。
- 服务器备份：`/home/ubuntu/scenarioforge/deploy/private/backups/repository-import-20261108T120734Z/`，含 `projectdb.sql`、`source.tar.gz`、`.next.previous` 和原始文件校验清单。
- 发布脚本及记录：`/home/ubuntu/repository-import-20261108T120734Z/`；隔离源码：`/home/ubuntu/scenarioforge-build-repository-import-20261108T120734Z/`。
- 无依赖变更、数据库迁移、MCP 变更或配置覆盖。发布前后确认无活动研究、成员 Agent 及知识索引任务。
- 回滚应用时，先停止 Web，保留当前构建，恢复 `source.tar.gz` 和 `.next.previous`，移除校验清单标记为新增的 `lib/repository-backend.ts` 后重启；数据库备份仅用于灾难恢复，不应直接覆盖发布后的用户数据。
