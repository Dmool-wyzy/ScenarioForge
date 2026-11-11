# 项目文档目录

文档按用途分组，文件暂留原路径以保持已有相对链接有效。新成员建议先读部署与使用手册；维护者再进入开发、部署和历史验收记录。

## 新成员与日常使用

- [本地与服务器部署使用手册](DEPLOYMENT_AND_USAGE.md)：安装依赖、本机部署、服务器拓扑、Runner 配对、日常使用和故障排查。
- [ScenarioForge 详细使用手册](USER_MANUAL.md)：项目、研究 Markdown、技能交接、GitHub、本地目录、模型、RAG 和功能限制。
- [本地工作区 Runner](LOCAL_RUNNER.md)：Runner 安装、配对、命令审批、Docker 隔离、文件边界和并发限制。
- [工作区 Agent](WORKSPACE_AGENT.md)：Agent 工具、技能快照、任务状态和执行约束。
- [RAG 配置](RAG.md)：Embedding、索引、检索、引用和迁移说明。
- [示例输入](EXAMPLES.md) · [演示脚本](DEMO.md)

## 功能说明

- [Git 仓库导入](REPOSITORY_IMPORT.md) · [Git 工作区](REPOSITORY_WORKSPACE.md)
- [个人中心](PERSONAL_CENTER.md) · [我的下一步](MY_NEXT_STEP.md)
- [贡献记录与成长等级](CONTRIBUTIONS.md)
- [研究生成修复记录](RESEARCH_GENERATION_FIX.md)

## 开发与运维

- [开发环境与架构](DEVELOPMENT.md)
- [Ubuntu 单机部署运维 Runbook](../deploy/README.md)：适用于现有服务器配置，不是通用安装器。
- [交付与接续说明](HANDOVER.md)：当前部署状态、限制和待办。
- [清理与保留清单](CLEANUP.md)：2026-11-08 的历史清理记录，不代表当前工作区状态。
- [RAG 改进计划](RAG_IMPROVEMENT_PLAN.md) · [Agent 协作设计](AGENT_ORCHESTRATION_PLAN.md)

## 发布与验收档案

日期化的部署、发布、诊断、恢复和测试记录是不可互换的历史证据。排查某次发布时按时间查看，日常部署以当前 [Ubuntu Runbook](../deploy/README.md) 和总手册为入口。

- [最新诊断补修部署](DEPLOYMENT-WORKSPACE-DIAGNOSTICS-20261111.md) · [文件恢复部署](DEPLOYMENT-FILE-RECOVERY-20261111.md) · [模型协议部署](DEPLOYMENT-MODEL-PROTOCOL-20261111.md)
- [版本更新说明](RELEASE_NOTES_20261111.md) · [模型执行策略](MODEL_EXECUTION_POLICY_20261111.md) · [模型协议验收](MODEL_PROTOCOL_VALIDATION_20261111.md)
- [方案工作流验收](PLAN_WORKFLOW_VALIDATION_20261111.md) · [工作区 Agent 验收](WORKSPACE_AGENT_VALIDATION_20261110.md)
- [综合验证记录](VALIDATION.md) · [历史 2026-11-09 发布](RELEASE_NOTES_20261109.md) · [历史部署](DEPLOYMENT-20261109.md)
- [文件恢复设计记录](WORKSPACE_FILE_RECOVERY_20261111.md) · [早期部署记录](DEPLOYMENT-20261111.md)

验收截图归档在 [`evidence/`](evidence/)。测试运行时生成的临时结果位于被忽略的 `test-results/`，不作为正式证据分发。
