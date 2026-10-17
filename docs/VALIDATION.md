# 验收记录

## 项目模型凭据优先级与引用校验（2026-10-17）

- Node 与 Python 的模型调用优先读取项目 `.env.local` 中的模型 key、API 地址、API 模式、模型名及超时，不修改系统变量。空项目 key 直接报错，不回退系统 key；隔离测试显式使用 `SCENARIOFORGE_ENV_FILE`。
- `check:model-config` 和 Python `check_llm.py` 使用不同的项目/系统假 key，检查实际 HTTP Authorization 使用项目 key，并覆盖空 key、两种 API 模式、网络错误不重试及日志脱敏。真实本机配置仅输出匹配结果，确认两端均使用项目 key，未输出令牌。
- Markdown 链接校验识别 URL 内括号、HTML 转义、默认端口及来源片段；未知域名、路径和查询仍拒绝。正文优先使用证据卡编号和 SOURCES.md，遇到未知外链最多修正一次内容，修正后仍不合格则停止，网络错误不重试。
- Python 文件生成 6 项、模型适配 4 项、研究工具 10 项回归及 Node 凭据回归通过，ESLint 和 TypeScript 检查通过。真实研究包 `cmvbtawt3001gf81cl5vu5ewm` 保留 21 张证据和原 README.md，补齐 RESEARCH.md、SOURCES.md、EVENT_PLAN.md、BUDGET.md 后状态为 completed，ZIP 下载返回 200。此前研究包 `cmvbotgbu000gf8fwpjo3bpbw` 也保留 25 张证据并补齐全部 5 份文件。

## Node 模型建连超时修复（2026-10-17）

- 复现原生 fetch 在约 10.6 秒报 `UND_ERR_CONNECT_TIMEOUT`，早于配置的 120 秒模型请求上限。
- 模型客户端使用配套的 undici fetch 与独立 Agent，建连、响应头和响应体超时均使用 `MODEL_TIMEOUT_SECONDS`；研究结束时销毁连接池。SDK 与 Runner 仍不自动重试。
- `npm run check:model-transport` 通过：本地 TCP 服务将 TLS 握手保持 11.5 秒后断开，验证连接未在 10 秒提前超时、只发起一次连接，且不需要真实模型凭据。ESLint、TypeScript 检查通过。
- 真实研究包 `cmvbqofs0005sf8fwj474aeh6` 恢复后完成首个问题检索并保存 5 张证据；后续 Python 模型连接失败而停止。模型中转的 5 次只读连通检查中有 1 次 TLS 握手超时，当前网络问题仍未解决，不能将本次修复记为完整研究流程通过。

## 工作区生成超时修复（2026-10-16）

- 真实故障日志显示：五个问题的检索已完成、25 张证据已入库；未启用 RAG 的旧分支一次请求七份文档，在 90 秒超时后由 SDK 再重试一次，最终未保存任何文件。
- 未启用 RAG 时改为有界证据选择、单文件请求、即时落库，每次工具调用最多处理三份文件；按输入指纹跳过已完成文件，保留用户编辑。来源索引直接整理已保存的真实来源，不调用模型。
- Python 与 Agent 两端模型请求默认超时 120 秒，`MODEL_TIMEOUT_SECONDS` 可设为 10–300 秒，关闭 SDK 对超时、限流及连接失败的自动重试；无效 JSON 仍允许一次格式修正。生成故障返回文件名及安全错误原因，本轮立即停止。
- `scripts/check_generation.py` 四项测试通过：部分保存后超时与断点恢复、非法外链停止、锁/阻塞澄清、百张证据的有界输入。`scripts/check_llm.py` 三项测试通过：两种 API 模式、JSON 修正、超时/限流单次 HTTP 请求及错误脱敏。MCP 真实 SDK 选择测试验证具体文件超时直接终止。
- `npm run check:agent` 两种 API 模式完整流程及搜索失败场景通过，使用独立数据库、测试端口 3001、独立 Next.js 构建目录及本地夹具，不消耗真实模型 token。
- 模型连接超时、连接失败、限流和认证失败的安全诊断测试通过；ESLint、TypeScript 与最终生产构建通过。SDK 和 Runner 两层均不自动重试模型请求。
- 2026-10-17 已重启真实服务并恢复研究包 `cmvb4kfcd0000f8yowyd46xv2`：普通 Agent 恢复曾在工具调用前遇到连接超时；只读模型列表确认服务地址、专用 key 和模型可用后，直接经真实 MCP 分三批完成七份文档，未重新搜索，保留原有 25 张证据。来源索引不调用模型；其余六份逐一请求、逐一落库，状态已恢复为 completed。自动化夹具验证与真实恢复分别记录，生成内容仍需人工复核来源。


## RAG 改进（2026-10-16）

- 第四次增量迁移 `20261016060000_rag_foundation` 已应用。先复制数据库并校验记录数、外键和 integrity_check；备份保存在 `.tmp/before-rag-20261016-222339.db`。
- 旧资料已无模型调用回填：保留 7 个研究包、86 张证据卡、0 个工作区文件和 6 条澄清；新增 20 个稳定研究问题、121 个来源、126 个来源版本及索引任务。未重新搜索或修改历史结论。
- `npm run check:rag` 通过：三个指定场景、中文/代码/表格分块、向量数量/维度/有限值/零向量校验、HTTP Embedding 返回排序、项目隔离、来源过滤、阈值不足、重复索引去重、回填幂等、来源历史版本回查、引用白名单、上下文变更、索引租约恢复、新代次失败保留旧索引、ZIP 证据索引。
- `npm run check:rag-agent` 通过：两种 API 模式均经真实 SDK → HTTP MCP → Next.js → 隔离 SQLite，完成研究、额度耗尽后复用、阻塞澄清与恢复、逐文件 RAG 检索/引用保存、用户编辑后重新读取与安全追加。外部搜索失败仍产生 search_failed 且不生成伪造文档。
- 上述 RAG 环境中浏览器 8 项全部通过：三个场景的证据过滤、相关检索、分数、引用详情、代码中引用不转换、ZIP 证据索引，以及原预览/SSE/下载/表单/澄清/编辑回归。
- `npm run check:agent` 两种模式的旧流程和故障场景通过；Python 研究工具 10 项、Search Provider 14 项、DDGS endpoint 4 项及 MCP 作用域/关闭创建 Schema/错误即停止的 3 项选择测试通过。61 秒慢调用测试本轮未重跑。
- ESLint、TypeScript 和 Next.js 生产构建通过。两个真实本地服务恢复运行，首页 HTTP 200；CLI 经真实 MCP 成功查询已有研究包和 RAG 状态，无模型调用。
- 自动化模型、搜索和向量均为本机确定性夹具，未调用真实付费服务。真实 Embedding 地址、key、模型尚未提供；`.env.local` 已添加空配置项并保持 `RAG_ENABLED=false`，旧研究包未自动重新排队。

配置和使用见 [RAG.md](RAG.md)。真实来源质量、语义引用支持度、服务商 Embedding 兼容性和大规模索引性能仍需对应环境验收。

验证日期：2026-10-15。本机环境：Windows、Node.js 24.19.0、Python 3.13.5。

## 各阶段交付

| 阶段 | 已交付 |
| --- | --- |
| 1 | Next.js、TypeScript、Tailwind、Prisma、SQLite、环境变量示例与基础布局 |
| 2 | Python FastMCP、Streamable HTTP、研究规划、搜索查询与带来源证据卡、uv.lock |
| 3 | Agents SDK、数据库任务与会话持久化、研究 API、SSE 和事件补发 |
| 4 | 五份 Markdown 生成、版本校验、单文件与 ZIP 下载 |
| 5 | 目标与约束表单、四种文件上传与解析、时间线、预览和下载界面 |
| 6 | 文本/单选/多选澄清、回答校验、阻塞等待与恢复、超时和默认假设 |
| 7 | Markdown 编辑、锁与续期、保存冲突、用户原文保护、Agent 重新读取 |
| 8 | 架构、启动与环境说明、三个示例、演示脚本、开发说明和自动化验证 |

## 已通过的检查

以下为首次八阶段交付时的记录。当时使用固定五份文档、八个 MCP 工具；后续动态文件计划修改的检查范围见下节。

- ESLint、TypeScript 检查及 Next.js 生产构建。
- Prisma migration 已应用；包含初始化、持久化任务与编辑保护三次迁移。
- 首页 HTTP 200。
- MCP Inspector 通过 Streamable HTTP 发现全部八个工具；`uv run` 启动方式已验证。
- 本地 API 集成：内部认证、持久化、证据编号、公开数据边界、SSE 与序号补发、版本冲突、下载内容、ZIP 文件清单、编辑锁、用户原文保护、Agent 通知、澄清恢复、非法选项和超时策略。
- 四项真实浏览器检查：实时预览与下载、示例和上传边界、澄清卡片、编辑保存及 HTML 脚本不执行。
- Python 模型适配器两项检查：Chat Completions 强制工具调用、Responses JSON Schema 输出；均验证无效 JSON 的一次修正。
- 两种 API 模式的完整 Agent 链路：真实 Agents SDK → HTTP MCP → 数据库，完成规划、三个问题检索、暂停、回答恢复、五份文件生成、用户修改、同一 session 重新读取与追加建议。
- MD、TXT、PDF、DOCX 上传真实解析，以及 TXT 20,000 字符截断，已在完整链路中验证。

## 动态文件计划调整

- 默认三份必需文档；其他按场景选择，生成前展示用途、优先级和要点。
- 新增 `update_file_plan`，当前共有九个 MCP 工具；追加计划、动态标签页、写入校验和完成检查已同步调整。
- 文件计划保存在已有 JSON 字段，不新增数据库迁移；现有检查夹具已同步新结构。
- 本次仅进行 ESLint、TypeScript、Python 语法检查和生产构建；未重新运行集成、浏览器、Agent 流程或真实外部服务测试。

## Search Provider 重构

- Provider、工厂与错误处理共 13 项测试通过：默认 Mock、四种工厂选择、按需配置校验、零搜索网络调用、SearXNG 参数与转换、Tavily 请求、DDGS 桥接、HTTP 错误、超时、无效 JSON、空结果及安全 URL。
- DDGS endpoint 的 4 项测试通过，实际请求 FastMCP ASGI 路由，覆盖内部认证、输入校验、库调用参数、返回规范化、去重、缺依赖、超时、限流、空结果和异常脱敏；DDGS 网络调用使用测试替身。
- 本地 API 集成通过：搜索额度按研究问题计数、Mock 来源强制未验证、SSE 补发、单文件/ZIP 下载、编辑冲突与原文保护、澄清恢复及超时。
- 浏览器 5 项测试通过，含 Provider、query、结果数量及失败错误码的 SSE 展示，并回归预览、下载、刷新、表单、澄清与编辑。
- 两种 API 模式的完整 Agent 流程均通过，使用真实 SDK、HTTP MCP、数据库及正式 Mock Provider；SearXNG 上游故障场景确认产生 search_failed、零证据、零文档，写入校验仍有效。
- ESLint、TypeScript、Python 语法检查及 Next.js 生产构建通过。不新增数据库迁移。
- 本轮未连接真实 Tavily、SearXNG 或 DuckDuckGo，也未运行 Docker；真实联网可用性及 SearXNG 容器启动需要在对应环境验收。

## MCP 慢调用修复（2026-10-16）

- 修正 Agents SDK 工具请求独立使用 60 秒默认超时的问题，显式将工具调用上限设为 660 秒。
- 工具开始、结束和失败均写入进度事件。传输错误或 MCP 工具错误会停止本轮，不再把通用错误交回模型反复调用；SDK 包装后的错误仍能显示具体失败步骤。
- `npm run check:agent-tools` 使用真实 SDK 和本地 HTTP MCP 测试服务，验证 61 秒调用成功、工具报错后仅一次模型调用、跨研究包参数被覆盖，以及取消请求不会报告成功；不访问模型服务或实际数据库。
- 两种 API 模式的完整离线 Agent 流程及搜索上游故障场景均已回归通过。真实服务商的响应时间、模型输出和搜索可用性仍需单独验收。

## 真实联网验收待配置

真实研究需要可用的 OPENAI_API_KEY 和一个可用的真实搜索 Provider。仅 tavily 需要 TAVILY_API_KEY；searxng/ddgs 无需该 key。模型的完整链路检查使用本地夹具，搜索默认使用正式 Mock Provider，不产生付费 API 请求。

配置可用凭据并确认服务商支持 `SCENARIOFORGE_MODEL` 后，按 `DEMO.md` 的三个示例进行真实研究，验收来源质量、文档内容和模型实际可用性。自动化夹具结果不代表真实研究结论。
