# 模型协议与文档失败提示修复验收

本记录对应2026-11-11的模型协议补修。修复在独立环境验收后，经用户授权于16:23发布，当前发布标识 `model-protocol-20261111`。上线过程、备份及无模型验收见[部署记录](DEPLOYMENT-MODEL-PROTOCOL-20261111.md)；当日13:49的生产记录仍作为此前基线保留。没有新增迁移或代为保存项目模型配置。

## 已确认的问题与修复

线上失败任务连续三次记录 `documents_requested → documents_started → documents_failed`，错误为HTTP400，文件数为0。当前保存的是官方DeepSeek Chat Completions；方案Agent通过SDK发送 `response_format.type=json_schema`，而该服务商Chat接口只支持 `text/json_object`，存在明确协议能力冲突。旧Responses连接测试只留下通用失败消息，无法恢复当时确切上游状态或断言单一根因。

旧测试把强制函数工具与Schema文本放入同一次Responses请求，成功后仅验证工具参数；UI将异步文档失败显示成普通“尚未保存”空态，研究进度还会收起。

修复将基础文本、严格函数调用、Schema文本分成手动选择的三个小请求，按所选协议分别组包与解析；不自动重试、切协议或改地址，不把Schema降为JSON模式。未知服务商不按Chat协议一概判定不支持；已知官方DeepSeek Chat的Schema最终输出在生成API、Worker及Node Provider分别检查。预排队检查与领取任务之间若配置变化，仍可能排队后安全失败。

Responses非流式解析另接受合法 `reasoning.content`，补SDK要求的空summary并保留原始content供工具后续回传；不会将思考正文作为最终回答。畸形响应、错误协议、超限响应继续失败。流式响应保持原先透传，本次不宣称覆盖所有流式变体。

文档区显示失败原因、保留旧文件、允许手动重新规划并再次确认；进度在失败后展开。模型测试结果按当前草稿显示，编辑或保存配置后清除，不写入数据库。

## 离线与网页验证

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| `check-project-model-settings.ts` + `check-model-transport.ts` | 99/99 | 两协议分离、三项测试、严格参数校验、HTTP400/401/429/500、恶形错误参数、安全诊断、无重试、DeepSeek Chat Schema零请求拦截、流式拦截、合法reasoning回传、错误协议拒绝 |
| `check-plan-documents.ts` | 15/15 | 确认文档清单、SDK输出、原子保存、人工修改/版本/租约保护 |
| 工作区/团队Agent/Agent工具回归 | 26/26 | 真实本机HTTP/SDK夹具，无付费模型；包含61秒工具预算用例 |
| `tests/plan-workflow.spec.ts` | 18/18 | 包含初始失败、SSE异步失败、旧文件保留与手动重新规划 |
| `tests/model-capabilities.spec.ts` | 2/2 | 项目和个人设置分别选择能力、400与超时、改配置清结果、测试不保存 |
| 类型、ESLint、生产构建 | 通过 | 隔离构建输出 `.tmp/next-agent-build`，不替换运行服务 |

离线与浏览器测试不发送真实模型请求。首次组合回归有一条旧连接测试仍期待函数输出，已更新为新的基础文本语义，随后协议组合99/99通过。全项目ESLint曾遍历临时部署脚本和受保护测试目录，已将整个 `.tmp/` 作为运行产物排除；正式源码与测试仍检查。

## 经授权的服务器真实小请求

用户单独授权：复用服务器现有DeepSeek凭据，独立验收目录中使用Responses协议，最多3次请求，每项512输出token/60秒，无自动重试，仅固定测试文本。凭据仅在服务器内存使用，未发送项目文件，未写入报告或源码。每项运行前创建独占attempt标记，脚本重跑不能重复已发出的调用。

模型为 `deepseek-v4-pro`，官方 `api.deepseek.com`，最小测试显式 `reasoning.effort=none`。结果于2026-11-11北京时间约16:00完成：

| 测试 | 结果 | 耗时 |
| --- | --- | --- |
| 基础连接 | 通过，返回非空文本 | 647ms |
| 严格工具调用 | 通过，指定函数参数精确匹配 | 1639ms |
| JSON Schema文本 | 通过，完整JSON通过字段校验 | 1118ms |

授权的3次调用已用完，没有继续调用。脱敏JSON保留在本地 `.tmp/model-protocol-acceptance-20261111/results.json`；服务器结果与attempt标记在私有发布目录的 `model-protocol-acceptance/`。这些运行资料不上传GitHub。测试后只读核对：Web仍active、原发布归档哈希匹配、项目配置及更新时间未变化，协议仍为Chat，失败任务没有被自动重新执行。

这证明当前服务器网络、凭据、模型及Responses的三项最小能力可用，不能证明旧故障的唯一成因，也不能替代长文档、复杂工具、默认思考或完整工作区验收。

## 仍待完成

1. 已发布修复，Linux构建及离线114/114、无模型HTTPS9项检查通过，任务空闲检查与回滚备份完成。
2. 用户在网页手动选定并保存合适协议；本次未代为将项目配置切成Responses。
3. 另行授权完整方案生成与下游Agent链路验收；本次只有三项固定小请求，没有生成正式方案文档。
4. GPT/OpenAI、Claude、Gemini、DeepSeek完整服务商适配、服务器出站代理及真实RAG仍为后续扩展。

协议依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[DeepSeek Responses](https://api-docs.deepseek.com/api/create-response/)、[严格工具调用](https://api-docs.deepseek.com/guides/tool_calls/)。

上线后另在真实HTTPS页面完成全模拟API浏览器回归20/20，保留TLS校验，无真实账号、数据写入或模型调用，范围及证据见[上线记录](DEPLOYMENT-MODEL-PROTOCOL-20261111.md)。
