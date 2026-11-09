# RESEARCH.md 生成失败修复（2026-11-08）

## 诊断

- 研究包 `cmw7yo472000auor0l22nby2v` 在北京时间 23:10:20 停在 `RESEARCH.md`，状态 `failed/idle`。
- 服务器日志显示该文件的两次模型请求均消耗 4096 输出 token，恰好达到旧的单文件上限；两次随后都发生结构校验失败。高度符合输出截断，但旧日志没有保存 finish reason 或原始输出，无法回溯证明具体 JSON 断点。
- 数据库只读检查确认 README.md 第 1 版（1926 字符）、25 条证据、5 个已回答澄清仍在。没有删除、重置或补写用户数据。

## 修改

- `mcp-server/llm.py`：GeneratedFile 上限提升到 8192 token，搜索和证据提取上限保持原配置，整轮 96000 输出 token 和 72 次调用的预算继续约束请求。
- 文档提示明确总输出预算，要求简洁覆盖要点、保留引用、预留 JSON 闭合空间，继续遵守用户更短的篇幅要求。
- 识别 Chat Completions 的 `finish_reason=length` 和 Responses 的 `incomplete_details.reason=max_output_tokens`。兼容接口省略结束标记时，只在 JSON 验证失败且已达到本次实际 token 上限的情况下推断截断。
- 截断最多精简重生成一次，不拼接残缺 JSON；若仍失败，返回 `model_output_truncated`。其他格式错误仍返回 `invalid_model_output`，Responses 的其他 incomplete 状态不会被当成完整内容保存。
- 日志只增加结构类型、尝试次数及 token 数，不记录文档正文、密钥或供应商响应体。

## 验证与上线

- 本地 Python：`scripts/check_llm.py` 14 项、`scripts/check_generation.py` 8 项通过。覆盖两种 API、截断信号、兼容接口缺少信号、格式错误区分、预算、有限重试，以及已保存文件保留和继续缺失文件。
- 本地 Agents SDK/MCP HTTP 检查 `scripts/check-agent-tools.ts` 11 项通过。
- 服务器独立暂存目录使用生产 Python 3.11 venv 重跑上述 22 项 Python 检查通过。全部使用模拟模型响应，没有真实付费模型调用。
- 发布标识 `llm-truncation-20261108`。停服务前和停止 Web 调度后均检查活动/排队研究及运行子任务为 0；更新 Python 适配器及两份检查脚本，随后启动服务。无迁移，无 Next 构建或配置修改。
- MCP 实际握手及 15 项工具列表通过；Web 首页恢复 HTTP 200，Web/MCP/MySQL 均 active。
- 服务器备份：`/home/ubuntu/scenarioforge/deploy/private/backups/llm-truncation-20261108/`，包含被替换的 Python 适配器和两份检查脚本。回退时只恢复这些代码并重启 MCP，不覆盖数据库。
- 本地连接现有 projectdb，队列研究由服务器执行，因此此修复已应用到本地页面提交的研究任务。

## 用户继续测试

修复没有自动重跑该任务，旧失败事件作为历史记录保留。在原研究包的“继续与 Agent 对话”发送：

> 继续刚才中断的文档生成。复用已有证据和澄清回答，保留已生成的 README.md，从 RESEARCH.md 开始补齐文件计划中的缺失文件，内容简洁，暂不派发成员任务。

实际供应商模型的本次任务续跑结果仍需由这一步确认；模拟测试和服务健康检查不等于真实文档已经生成成功。
