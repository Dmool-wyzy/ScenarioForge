# 验收记录

2026-11-11 源码交付摘要见[本版说明](RELEASE_NOTES_20261111.md)；同日已完成服务器发布和三条新增生产迁移，详见[上线记录](DEPLOYMENT-20261111.md)。公开的模拟资料截图为[方案页](evidence/workspace-research-20261111.png)、[执行页](evidence/workspace-execution-20261111.png)、[手机页](evidence/workspace-mobile-20261111.png)；原始 `.tmp/` 日志及运行数据不随仓库分发，下文路径仅供原开发机追溯。

此次服务器验收通过 Linux 离线回归 133/133、独立 MySQL 测试 19/19、真实 Docker 隔离测试 1/1，以及生产 HTTPS 登录、文档清单预览、Runner API 配对、目录心跳与撤销。临时数据库、账号和业务数据均已清理，原生产配置保持不变。此次没有调用真实模型、运行远程 Runner CLI 或验证完整 GitHub Agent 链路；静态资源检查不代表浏览器布局交互验收，相关完整流程继续待验。

上传前将 `check-project-agent`、`check-plan-documents`、`check-task-scheduler`、`check-model-transport`、`check-project-model-settings`、`check-workspace-agent`、`check-workspace-agent-tool-concurrency`、`check-local-runner-filesystem`、`check-local-runner-cli`、`check-local-runner-commands` 十组离线回归合并复核，共 133/133（含子测试）通过，全项目 ESLint 通过。全部使用本机夹具，无真实模型调用；其中方案等用例与下文分次验收重合，不重复累计。此次在 Windows 运行，文件权限及符号链接的部分检查仍需 Linux，不能据此声称跨平台全验。

2026-11-11 的显式方案文档、技能交接与本地 Runner 验收见[专项报告](PLAN_WORKFLOW_VALIDATION_20261111.md)。本次模型为本机 HTTP 夹具，没有真实模型费用；此前真实模型与 Docker 的范围见[2026-11-10 记录](WORKSPACE_AGENT_VALIDATION_20261110.md)。

同日可编辑文档清单更新已完成：本地规则预览、用户确认 1–20 份后单次生成；方案回归 15/15，浏览器组合 34/34 与过期清单补验单项 1/1，类型检查、ESLint 和隔离生产构建通过。独立 MySQL、真实网页及 Runner 联合验收通过，现场保存三份文档、交接冻结技能、修改文件并完成审查，独立 Node 测试 5/5；本机模型夹具无付费调用。最终报告 `.tmp/plan-joint-fixture-zBzXgA/report.json`，临时测试库及服务已清理。完整范围、一次脚本定位失败及重验记录、尚待真实模型/Docker 验收事项见专项报告末尾“同日更新：可编辑文档清单”。

后续双页签改版已完成：方案与执行分区、顶部目录/连接/待审批提示、切换保留草稿和编辑锁、历史折叠及深链兼容。组合浏览器 42/42、五项集成用例分次通过，类型检查、ESLint、隔离生产构建通过；新布局的独立数据库/网页/Runner 联合验收及可信 Node 测试 5/5 通过。报告 `.tmp/plan-joint-fixture-JDNHGS/report.json`，测试库与临时服务已清理，无真实模型或 Docker 调用。截图、完整范围和后续待办见专项报告“双页签工作区”追记。

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

## 2026-11-06：账号、项目和公网部署

- 公网入口：`https://175.27.143.14`。Node 24.22.2、Python 3.11.18、MySQL 8.4.13；网页与 MCP 以独立 systemd 服务运行，nginx 提供 HTTPS。3000/8000 只监听回环。
- MySQL 迁移应用前已备份；原 SQLite 迁移保留在 `prisma/sqlite-migrations`。新账号、项目、成员和会话表已部署，旧匿名研究不自动公开。
- 生产构建、TypeScript、相关 ESLint、数据库配置/URL 来源键自检、DOCX 实际解压体积自检均通过。
- `check:project-access` 的真实 HTTP/MySQL 回归通过：注册登录、会话轮换与退出、邀请码唯一与加入幂等、非成员/匿名拒绝、跨站拒绝、编辑锁与版本保护，以及会话撤销/过期/成员移除后的 SSE 关闭。
- Multipart 回归确认项目权限检查早于 DOCX 提取：非成员返回 404，匿名返回 401。压缩炸弹、累计解压体积与条目数上限自检通过。
- 公网 HTTPS 实测通过注册、Secure/HttpOnly 会话 Cookie、创建项目、六位邀请码、第二账号加入、重复加入去重、退出撤销、内部 API 404 和 HTTP 跳转 HTTPS。仅清理本次自建且无研究资料的测试账号/项目，保留其他数据。
- 本机浏览器已验证登录、项目大厅、进入项目和邀请码展示，并保留界面截图；公网登录页 DOM 已加载，内嵌浏览器的完整公网交互复测因控制连接超时未完成。另一次既有浏览器回归为 6 通过、3 个 RAG 专用测试跳过。
- MCP 初始化与 15 个工具列表检查通过，未调用模型。前端静态包检查未包含数据库密码或内部令牌。
- 网页与 MCP 已设开机启动；证书定时续期服务执行成功，ACME 模拟续期通过。MySQL 证书已补齐 IP SAN、AKI/SKI，并通过 VERIFY_IDENTITY 及 Prisma 严格 TLS 检查。
- 尚未接入真实模型、真实搜索及 Embedding，RAG 保持关闭；未进行压力测试或真实模型全链路验收。既有依赖审计告警未通过跨主版本升级处理。

## 2026-11-07：项目模型 API 设置上线

- 创建者可在项目页填写 HTTPS API Base URL、API Key、模型 ID、协议和超时，并保存、单独测试或清除；成员只读元信息。网页不包含允许模型名单。
- 项目设置使用绑定项目 ID 的 AES-256-GCM 加密。研究每轮固定配置快照，Node 规划器与全部 Python 模型调用共用；轮次结束清除快照。密钥及配置密文不进入公开研究或模型上下文。
- 两个可空 LONGTEXT 字段的 MySQL 迁移已应用，迁移前数据库与发布前源码均有私有备份。Linux Prisma 客户端生成、迁移检查及 webpack 生产构建通过；网页与 MCP 服务已更新并正常运行。
- TypeScript、相关 ESLint 和 `check:project-model-settings` 的 26 项离线检查通过，覆盖加密、项目绑定、地址校验/固定 IP、两种协议、错误脱敏、响应大小及超时边界。
- `check:model-settings-access` 的本地真实 HTTP/MySQL 检查通过：创建者/成员/非成员/匿名权限、无 key 元数据、空 key 保留、改地址须重新填 key、跨项目配置、本轮快照稳定及上下文不泄密；自建夹具已清理。
- `scripts/check-public-model-settings.mjs` 的公网 HTTPS 检查通过：可信证书、生产安全 Cookie、创建者保存/读取/更新/清除、成员只读和非成员/匿名拒绝。伪 key 只用于 example.com 地址的 DNS 校验，不发模型请求；自建两个账号、两个项目已清理。
- 生产 venv 执行 Python `check_project_model.py` 9 项、`check_llm.py` 4 项、`check_generation.py` 6 项、`check_research.py` 10 项，共 29 项模拟检查通过。无真实付费 API 调用。
- 本地浏览器验证登录、进入项目和展开表单，布局及字段正常，保留截图；本轮公网完整交互由 HTTP smoke 验证，未新增公网浏览器逐项复测。
- 公网首页 200，MCP 连接与 15 个工具列表正常；46 个前端静态文件未包含配置加密密钥、内部令牌或数据库密码。续期 timer、网页/MCP/MySQL 三项服务均正常。
- 未填入或验收真实模型凭据，默认搜索仍为 Mock、RAG 关闭。未做真实研究内容质量、真实搜索/Embedding、付费模型全链路或压力测试；连接测试按钮由用户自行触发，可能产生费用。

后续接续入口：工作区根 `D:\5\handoff.md`，含当前环境、关键代码、运维和待办；不包含真实凭据或模型名单。

## 2026-11-07：DeepSeek 真实调用与兼容修复

- 在用户指定的“申威课设”项目，通过 `nayun` 现有会话保存了项目专用模型配置；保存走已有加密 API，网页不回显 Key。未改账号、成员或其他项目。
- 完整 Key 调 `/models` 返回 200，目标模型在返回目录中。此前一次鉴权失败由助手漏输 Key 字符导致，不能据此判断用户凭据无效。
- 针对 DeepSeek 官方主机的 Chat Completions，连接探测、Node 研究 Agent、Python structured 生成统一关闭思考模式，兼容强制工具调用和当前 SDK 历史处理；其他主机、Responses 不受影响。连接测试新增明确的 5xx 提示，不暴露上游正文且不自动重试。
- Node 29 项离线检查通过，包括真实 Agents SDK 序列化的请求体、精确主机匹配、其他协议不受影响、错误脱敏与安全传输边界。Python 5+9+6+10 共 30 项模拟回归通过。本机 TypeScript/相关 ESLint、Linux webpack 构建与首页健康检查通过，无新依赖或数据库迁移。
- 真实调用未成功：本机与生产服务器最小 Chat 调用返回 HTTP 500，`/v1` 地址同样失败；Responses 关闭思考的短请求 45 秒超时。这说明本次推理请求受到上游错误阻塞，不能据此宣称服务商全局不可用。
- 网页具名测试研究 `cmw62ygte0002v67xkdqpxbbi` 成功排队并读取项目配置快照；第一轮 Agent 模型调用收到 HTTP 550 且无正文，未产生文件、证据或澄清。任务失败后处于 idle、快照已清除，项目配置仍保留；没有自动重试或伪造成功结果。
- 生产 Web/MCP/MySQL 均 active。真实文档生成、澄清与内容质量尚未验收；搜索仍为 Mock，RAG 关闭。

## 2026-11-07：后续定位与真实模型网页流程复测

- 本节更新上一节的阶段性失败结论。纯文本、最小工具调用和真实 Agents SDK 两轮对话均已成功过；相邻对照请求也有 5xx/超时，不能据此认定 Key 无效或某一请求形状始终不可用。
- 原具名测试要求“不超过 2 个研究问题”，与规划提示和 `ResearchPlan` 的 3–6 个约束冲突。重跑后 Agent 已调用创建工具，两次模型 HTTP 200 仍因 `researchQuestions: too_short` 失败；原记录保留为诊断证据。
- 新网页测试 `cmw641yr5000iv67x5crdeqhu` 在“申威课设”项目中明确要求恰好 3 个问题。真实模型完成计划、1 个阻塞澄清暂停、网页回答后恢复、3 次问题检索工具调用，以及 README.md、RESEARCH.md、SOURCES.md 的生成与保存。最终 completed/idle，三份文件均为 v1，配置快照已清除。
- 搜索为 Mock，9 条证据全部 low/unconfirmed；这是“真实模型 + Mock 搜索”的流程验证，不是真实联网研究。测试平台回答只用于临时复测，不代表课设实际硬件。
- 内容仍有未通过项：README/RESEARCH 含约 591/825 个汉字，超过要求的 400 字；查询出现提示词示例中的无关 SHWD 实体。未进行真实来源质量或内容质量全面验收。
- 规划工具的安全 `ModelFailure` 现在以 `planning_failed` 返回，Node 显示安全中文原因后停止本轮；不向网页透传原始模型正文、Pydantic 数据或任意 MCP 异常。新增失败计划不保存及 Runner 停止检查。
- Node 工具回归 10 项、相关 ESLint、TypeScript、生产 Python 研究 11 项与生成 6 项离线检查通过，无依赖变更或数据库迁移。RAG 仍关闭。
- 报错修复已部署；Linux webpack 生产构建、HTTP 首页健康检查通过，Web/MCP/MySQL 均 active。发布前已保留四文件源码和上一份 `.next` 构建用于回滚。

## 2026-11-07：研究与对话支持顶层 Agent

- 普通问答、翻译、计算等由顶层项目 Agent 在对话中处理；只有用户要求研究或生成/更新工作区文档时才调用已有研究 Agent。外层持有数据库会话，研究子流程读取持久化研究上下文。没有新增任意系统操作、终端或通信工具。
- 计划 schema 的研究问题下限从 3 调为 1，普通与 RAG 的 Node/Python 边界一致为 1–6。3 份基础 Markdown 是独立于问题数的文件要求；聊天不要求计划、搜索或这 3 份文件。
- `taskState` 单独表达对话轮次是否排队/运行，研究状态和阶段在普通聊天中保留。等待 blocking 澄清、阻塞或文件编辑期间，顶层 Agent 隐藏研究工具；因此仍可聊天且不能由 Agent 绕过用户的澄清回答或编辑锁。实际研究工具执行后仍验收所有必需计划文件。
- 验证通过：本地 TypeScript、ESLint、9 项 Project Agent 测试、3 项 Node 计划测试、既有 10 项 Agent 工具测试；Playwright 对话 UI 6 项；服务器 Python 计划 3 项、研究 11 项、文档生成 6 项；生产 Linux webpack 构建、首页健康检查和 Web/MCP/MySQL 服务状态。无数据库迁移或依赖变更。
- 公网真实 DeepSeek 测试在“申威课设”中新建具名对话：普通问候、英译、17×23 和跨轮代号记忆均仅聊天回答且不创建文件；同一对话随后要求 1 个研究问题，实际产生 1 个已完成问题、1 个 blocking 澄清和三份文件计划。澄清等待期间又验证了普通聊天，状态及计划未被改变；回答测试用平台选择后恢复，README/RESEARCH/SOURCES 三份 v1 文件写入成功，最终 completed/idle。
- 新记录 `cmw65b12y0002v6l3sghg0q93` 的最终持久状态与网页一致：1 个研究问题 completed、1 个 blocking 澄清 answered、3 份 v1 文件。为了完成恢复测试选择的“仅本地笔记本，无特定平台”只是临时测试输入，不代表实际课设环境。旧已完成包 `cmw641yr5000iv67x5crdeqhu` 三份文件版本与内容哈希未变；失败诊断记录亦保留。
- 本次网页研究的搜索 Provider 仍为 Mock，证据是低置信度测试数据；因此这验证真实模型 + Mock 搜索的 Agent/文档流程，不是联网研究来源验收。RAG/Embedding、项目跨研究的知识复用、远程 MCP 和真实来源质量未在本次验证。
- 本轮没有专用测试 MySQL，因此没有执行完整 `scripts/agent-e2e.mjs` 数据库夹具。生产更新无迁移、无密钥变更，发布前检查无运行中任务；两次构建均有回滚快照，第二次补丁构建成功并恢复全部三个服务。

## 2026-11-08：真实联网搜索 Provider 探测

- 检查确认生产 `SEARCH_PROVIDER=mock`，没有改配置或重启服务。现有 Provider 工厂已实现 DDGS、Tavily、SearXNG，生产 Python 环境安装 `ddgs 9.16.0`。
- 通过线上受鉴权 DDGS HTTP endpoint 用通用公开查询 `申威处理器 官方网站` 发起一次真实请求，30 秒后返回 504；未返回可评估来源。没有把 API Key、内部令牌或上游错误正文输出。
- 服务器向 DuckDuckGo HTML 搜索入口发起一次原始 HTTP 请求，12 秒 ConnectError；Bing 搜索入口在不跟随重定向的探测中返回 HTTP 302。通过同一 DDGS 库分别指定 `bing` 和 `auto` 后端，用通用公开查询测试，均出现 `TimeoutException`，没有来源结果。
- 因此 DDGS 的可用性和来源质量尚未验收，不能宣称真实搜索已接入；Bing 302 仅说明收到重定向，不能证明获得搜索结果。后续需给服务器配置可访问的搜索服务（Tavily API Key 或 SearXNG URL），或先排通出站搜索网络，再在“申威课设”中验证端到端来源质量。Mock 默认仍保留，无降级假结果。
- 五项未完成方向的最新状态和下一步见 `D:\5\handoff.md` 第 12 节。

## 2026-11-08：将联网搜索移出当前实施范围

- 用户确认当前项目成本有限，真实联网搜索暂时移出开发目标，继续保持生产 `SEARCH_PROVIDER=mock`。本次没有配置搜索 Key/URL、改生产环境或发起 DeepSeek Search/Fetch API 请求。
- 查阅 [DeepSeek 官方 Search & Fetch 文档](https://api-docs.deepseek.com/guides/search)：确有独立 `POST /v1/tools/search` 与 `POST /v1/tools/fetch`，使用 DeepSeek bearer Key，但它们不由普通 `deepseek-flash` Chat API 自动提供，需要应用明确集成。官方文档标价每 1,000 次成功 Search 请求 USD 0.75，每 1,000 次成功 Fetch 请求 USD 0.75；空结果/失败不收费。
- 后续一般聊天可使用模型已有知识；需要实时信息或可核验来源时必须说明未联网验证，且不将 Mock 证据表述为真实搜索结果。
- 新增外部服务、付费 API、Embedding、云资源和持续运维成本，在提供服务/计价/调用量估算/数据去向/替代方案并获得用户明确同意前，不配置、不采购、不发起真实请求。该确认规则同样适用于将来恢复 DeepSeek Search/Fetch。
 - 五项方向的当前/未来边界及该确认规则见 `D:\5\handoff.md` 第 12 节。

## 团队项目共享资料 MVP（已部署，集成验收待补）

- 新增项目级 ProjectKnowledgeItem 快照及 MySQL 迁移。成员可显式分享同项目证据卡；Mock 搜索证据会被拒绝，其他证据保留来源研究、来源链接、置信度与状态。添加者或项目创建者可归档/恢复。
- 项目页支持关键词搜索及资料管理。创建新研究时可搜索并选择最多 3 条共享资料，来源和可信状态一并进入新研究上下文；归档后不再供后续研究选择，不改动已创建研究的快照。
- 检索使用有限候选集上的中英文词项匹配，不调用 Embedding、模型或搜索服务，不产生新增外部调用费用；不提供语义检索，也未改写 RAG 的研究包范围。
- 验证通过：Prisma Client 生成、Prisma schema 校验、TypeScript、相关 ESLint、关键词排序测试（1 项）、Next.js 生产构建。
- 生产库迁移已应用，部署源码含项目知识 API；生产登录后的分享、归档、复用及跨项目隔离流程尚未重新做端到端验收。未把生产库当作测试库运行夹具。

## 后续授权：DeepSeek Search 项目试点

- 用户之后明确批准“可以启用”。新增 DeepSeek Search Provider，固定请求 DeepSeek 官方 `POST /v1/tools/search`，采用项目加密配置中的同一 API Key；Base URL 主机必须精确为 `api.deepseek.com`。请求沿用现有公网 IPv4 DNS 检查/IP 固定、超时、拒绝重定向和压缩、8 MiB 实际响应限制；query 限 128 个 Unicode 字符，`need_content=false`，不调用 Fetch、不自动重试。
- 在“申威课设”项目模型设置中新增项目级开关，默认关闭并随加密设置快照进入每轮研究。全局 `SEARCH_PROVIDER=mock` 未改，其他项目仍走全局设置。模型聊天本身不会自动联网，只有研究搜索工具调用此 API。搜索请求只发送工具生成的 query，不另发完整用户原始问题。
- 生产项目 ID `cmw4w4o800001v67so7vspjx5` 已启用。通过生产只读设置接口确认 `hasApiKey=true`、`deepseekSearchEnabled=true`；已注销测试会话。没有迁移或修改其他项目。
- 发起一次真实 Search：query 为“申威处理器 官方技术资料”，count=3、need_content=false，返回 3 条申威 411/111/421 处理器资料，结果均来自 `www.swcpu.cn`；三条来源页均通过直接 HTTP HEAD 检查（200）。标题和摘要与产品规格直接相关，初步来源质量良好；其中一条链接附有额外 query 参数，完整研究时仍需检查最终引用链接。此次 HTTP 200 且有结果，按官方费率计约 USD 0.00075；未调用 Fetch、未运行完整 DeepSeek 研究、未自动重试。
- DeepSeek 官方当前价格为每 1,000 次成功 Search 请求 USD 0.75；count 不影响单次价格。应用每研究包限制 12 次搜索工具调用，每次最多生成 3 个搜索 query，若全部成功，单包最高约 USD 0.027。没有项目/月度累计上限，重复创建研究包会继续累计。项目设置页展示费率、查询去向和单包上限。
- 验证：TypeScript、相关 ESLint、Next webpack 生产构建通过；`check:search` 17 项、`check:project-model-settings` 30 项、`check:agent-tools` 10 项、`check:model-config` 1 项通过。生产 Web/MCP/MySQL active，首页健康检查和项目设置元数据检查通过。无 DB migration。`check:rag` 需要独立 `SCENARIOFORGE_TEST_DATABASE_URL`，因当前没有专用测试库而未执行；没有使用生产库代替。
- 发布前备份：服务器 `deploy/private/backups/source-before-deepseek-search-20261107T0950Z.tar.gz` 和 `.next-before-deepseek-search-20261107T0950Z`。全局搜索配置和其他项目设置未改。

## 团队 Agent 派发部署验收（2026-11-07）

- 团队子 Agent 仅在当前研究轮次有项目专用模型时开放；顶层 Agent 可派发最多两个独立子任务。每项子任务最多一次模型调用、2048 个输出 token，且没有搜索、MCP、文件系统或外部操作工具；结果返回顶层 Agent 审核。
- 子任务目标、显式上下文、状态、结果及模型用量写入研究包关联记录。派发额度在新租约开始时清零，并通过数据库原子更新限制当前轮次最多两项。
- 本地验证通过：Prisma schema validate、Prisma Client generate、TypeScript、相关 ESLint、Project Agent 8 项、Team Agent 3 项、Agent Tools 11 项、Project Model Settings 33 项、Python LLM 9 项及 Next.js webpack 生产构建。
- 用户授权后已部署至服务器。发布前任务队列为 0；数据库和源码均有私有备份。生产仅应用 `20261107120000_team_agent_subtasks` 迁移，Prisma 状态无待应用迁移，新表查询成功且记录数为 0。服务器 TypeScript 检查、上述离线测试及生产构建通过；Web/MCP/MySQL 均 active，公网首页 HTTP 200。
- 没有执行真实模型请求。由于没有独立 MySQL 测试库，成员隔离、数据库写入失败、进程中断后的子任务状态恢复仍未做集成验收；真实网页派发与结果整合也未实测。Python 模型额度按活动租约归组，但仍保存在单 MCP 进程内存，MCP 重启会清零。
- Web 停止时超过 systemd 的 90 秒停止时限并被系统结束；之后已重置失败状态、重新启动并确认健康。后续部署应检查这一停止行为。

## 隔离 MySQL、完整 Agent 与真实团队派发（2026-11-08）

- 临时库 `scenarioforge_test_team_agent_20261108_6ddecf2a` 使用专用账号，仅允许 loopback 和该库；四条迁移成功应用。所有集成夹具均在此库运行，生产库不用于破坏性夹具。完成后确认研究/项目/用户记录为零，再删除该库、两个 loopback 账号和测试私有环境文件，验证库与账号均不存在。
- `check:db-integration` 通过真实 MySQL 与 API 路由测试：同项目分享/去重、拒绝 Mock 和跨项目资料、成员/非成员访问边界、添加者/创建者归档权限、新研究复用保留来源和可信状态、归档拒绝新选择但不改旧快照，以及团队子任务成功/失败持久化与租约接管后迟到结果拒绝。
- 租约保护已部署：接管时把旧轮次仍 running 的子任务标记失败；派发检查租约有效期；结果只更新仍 running 的子任务。迟到结果不覆盖接管后的失败状态。
- `scripts/agent-e2e.mjs` 完整通过 Chat Completions 与 Responses：真实 Agents SDK、HTTP MCP、Next.js API、MySQL、后台任务连通；改写问题仍按已保存问题下标检索、达到搜索上限后复用、阻塞澄清暂停/回答/恢复、按计划逐文件生成、用户编辑后重新读取及保留、会话 ID 保持一致。SearXNG 503 模拟验证 search_failed 事件、零伪造来源/文档及失败后的写入拒绝。模型、搜索和 Embedding 均使用本机夹具，没有远程供应商请求。
- 修复测试基础问题：Python 夹具补接 `package_id`，失败打印 MCP 日志；显式配置 Node PATH；用 Node `--env-file` 加载测试 dotenv；测试 Web 使用独立 3010 回环端口和 webpack。Turbopack 首次尝试曾因内存耗尽被内核终止；改用 webpack 后完整测试通过。3010/8001/9009 均已退出，没有影响生产数据库。
- 普通文档生成去掉固定 800–1500 字指令；普通/RAG 提示均优先遵守用户篇幅和格式。现有查询提示已去除无关 SHWD 示例。Python 生成 7 项、研究 11 项离线检查通过，新增覆盖用户“400 字以内”要求传到逐文件入口且无冲突默认长度。尚未重新运行真实文档生成验证严格字数，提示修复不等于硬校验或完整内容质量验收。
- 本地 TypeScript、相关 ESLint、团队子任务 3 项离线检查通过；生产 Linux webpack 构建通过，无新依赖和迁移。发布标识 `20261108T063146Z`；源码备份 `deploy/private/backups/source-before-lease-generation-20261108T063146Z.tar.gz`，旧构建 `.next-before-lease-generation-20261108T063146Z`。Web/MCP/MySQL active，公网 HTTPS 200，internal 公网路由 404，续期 timer active。
- 真实网页验收：nayun 在“申威课设”创建测试对话 `cmw7gmpma0002v66dnfltlekl`，两个独立虚拟需求评审被一次派发，网页进度显示两个 started/completed，顶层返回审核汇总。数据库最终 replied/idle、2 个 completed 子任务、每个 1 请求；无搜索、研究计划、证据或文件，本轮配置快照已清除。该记录保留在项目中，不代表真实课设需求；截图在 `docs/evidence/team-agent-live-20261108.png`。

| 调用范围 | 请求数 | 输入 token | 输出 token | 合计 token |
| --- | ---: | ---: | ---: | ---: |
| 子任务 1 | 1 | 238 | 80 | 318 |
| 子任务 2 | 1 | 236 | 87 | 323 |
| 顶层规划与汇总 | 2 | 4099 | 451 | 4550 |
| 整轮 | 4 | 4573 | 618 | 5191 |

子任务的 641 token 仅是整轮的一部分；没有按未经确认的单价估算金额，本例不证明费用下降。个人模型空间/收件箱、Git 隔离代码工作区、远程 MCP、跨进程 Python 共享额度和项目月度金额预算仍未实现；Embedding/RAG 和新增通用搜索服务继续按用户要求暂缓。

## 个人任务交互与 Git 文档演示（2026-11-08，发布前验证）

- 用户已确认 `user1` 收到真实网页派发任务 `SHENWEI-USER1-1108A`。本次把自动交付改为私有初稿、成员追问/编辑、确认提交、顶层审核；历史 completed 任务维持只读，新任务使用 review/submitted 状态。
- MySQL 专用隔离库 `scenarioforge_test_review_20261108` 应用全部 6 条迁移。集成检查通过：本人私有对话、组长/其他成员无法读取或操作、重复提交拒绝、6 次模型尝试上限、超时恢复及迟到结果拒绝、多个成员提交通知不丢失、提交正文/通知/排队原子写入，以及 Git API 成员权限。模型为夹具，没有访问远程供应商。
- 使用真实临时 Git 仓库验证独立工作区、任务分支、main 不被提前改动、只合并审查过的提交和基线，拒绝变更后的交付、错误提交号、过期基线及带未提交改动的主工作区。无外部 Git 连接、凭据、钩子、代码执行或模型调用。
- 离线 Project Agent 8 项、Team Agent 3 项、Git 1 项通过；TypeScript 和相关 ESLint 通过。Playwright 2 项新交互测试和原有 7 项对话/共享资料测试通过，API 全部为夹具。已检查截图 `docs/evidence/personal-task-interaction.png`。
- 用量边界：初稿加追问每项最多 6 次、每次最多 2,048 输出 token，无自动重试。成员确认提交会排队一个顶层审核轮次；Git 操作不使用模型。没有新增付费服务、依赖或全局模型配置。
- Git 当前只演示交付文档的版本管理；外部 GitHub/GitLab、代码执行和多 Web 进程仓库锁尚未实现。真实生产交互及发布结果待部署后追加。

### GitHub 补充与生产发布中断（历史，现已恢复）

- 用户指定 `https://github.com/nayun118/ScenarioForge.git`。官方 API 确认为公开空仓库，默认分支 main；本机 `git ls-remote` 成功且无引用。服务器 GitHub HTTPS Git 连接超时，官方 API 可达。没有向 GitHub 上传代码或提交，没有配置写入凭据。
- 本地新增公开空 GitHub 仓库关联功能：固定 github.com HTTPS 地址验证、GitHub 官方 API 空仓库检查、配置 origin、明确显示尚未推送。非空/私有仓库暂不导入；不自动替换已有远程地址。Git 2 项离线测试、3 项浏览器交互测试、TypeScript、ESLint 和 Windows webpack 构建通过；外部请求在单元和浏览器测试中使用夹具。
- 生产发布 `personal-review-20261108T083700Z` 已完成数据库/源码备份、6 条迁移和 Prisma 生成，Linux 12 项离线检查通过；生产 webpack 构建未完成。观察到构建 worker 内存约占主机 69.5%、CPU 约 300%，随后 SSH、HTTPS、MySQL 连续连接超时。尚未取得内核日志，不能断言 OOM 已发生。
- 已请求用户通过云控制台重启。旧构建保存在 `.next-before-personal-review-20261108T083700Z`，恢复步骤已准备在本机 `.tmp/recover-personal-review.sh`。需要恢复旧网页后，在独立源码目录、内存限制下构建并重新发布；不能把本地通过视为生产上线成功。最新运维状态以 `D:\5\handoff.md` 第 17 节为准。



### 重启恢复、成功部署与真实派发（2026-11-08）

- 用户确认控制台重启后，先恢复旧源码和构建，保留新增字段迁移，没有恢复旧数据库覆盖用户数据。第一次失败构建在约 16:38；恢复后读到的前一启动周期 OOM 日志为 14:23 的更早事件，不能据此认定本次失败也是 OOM。
- 独立源码目录 /home/ubuntu/scenarioforge-build-review-47m6frYq 不包含历史构建和私有运行时，只软链现有依赖与配置。systemd 设置 MemoryMax=4G、MemoryHigh=3500M、MemorySwapMax=0、CPUQuota=200%、TasksMax=128、RuntimeMaxSec=600，Node heap 上限 2048 MiB。Linux webpack 构建约 40 秒成功，旧网页期间保持在线。
- 发布 personal-review-staged-20261108T085510Z 已成功。备份为 deploy/private/backups/source-before-personal-review-staged-20261108T085510Z.tar.gz 和 projectdb-before-personal-review-staged-20261108T085510Z.sql；上一版完整构建为 .next-before-personal-review-staged-20261108T085510Z。全部 6 条迁移已应用，无待处理项。服务 active、首页 HTTP 200；匿名访问个人任务/仓库 API 返回 401。
- nayun 真实网页已将 https://github.com/nayun118/ScenarioForge.git 关联到“申威课设”，本地 main 已初始化 README。网页明确显示尚未推送。当前仅验证公开空仓库并配置 origin，不导入非空仓库、不执行代码、不向 GitHub 写入，没有配置远程写凭据。服务器 Git HTTPS 曾超时，远程同步连通性仍待解决。
- 真实派发 SHENWEI-INTERACT-1108B：研究包 cmw7llawl0002v6tprt7xq4un，user1 子任务 cmw7llbxs0009v6tpno652zsx。内容为普通笔记本、固定数据、离线演示的 3 条验收点，明确为功能测试。子任务 review、revision=0，初稿和私有对话未发给顶层；顶层回复等待成员讨论和确认。父包 replied/idle，搜索、证据、文件均为 0，本轮配置快照清除。
- 用量：个人初稿 1 请求、244 输入/49 输出 token；顶层 2 请求、3979 输入/245 输出 token；全轮 3 请求、4223 输入/294 输出，共 4517 token。未换算金额，不据此宣称成本下降，没有追加搜索或完整研究测试。
- 追问、编辑、提交、并发通知及 Git 权限已有隔离 MySQL/API 和浏览器夹具验证；线上只验证了真实派发与私有初稿等待、组长关联 GitHub 地址。没有代替 user1 在线追问/提交/入库/合并。用户可在“个人 Agent 与任务收件箱”选择新测试，追问并编辑交付、确认提交，再保存到任务分支，由组长查看差异后合并本地 main。旧任务 SHENWEI-USER1-1108A 保持只读。
- 截图：D:\5\ScenarioForge-main\docs\evidence\personal-review-live-20261108.jpg。组长个人模型仍未配置；组长也可在自己的面板配置并开启接收，不共用 user1 的个人凭据。
- 隔离测试库 scenarioforge_test_review_20261108 和账号 sf_review_test_1108 已删除并核验为零。后续临时文件清理被自动审批拦截，工具仅返回 blocked by policy；缩小到单个本地临时环境文件仍被拒绝。因此本机 .tmp/review-test.env、服务器 deploy/private/review-test.env 和测试辅助文件仍保留，但测试账号已失效。没有绕过拦截改用其他删除方式。
- 本次构建残留仍保留：独立源码目录约 1.8 MiB，.next-aborted-20261108T085244Z 约 309 MiB、无 BUILD_ID。当前生产 .next 完整。磁盘约余 3.7 GiB，下次发布前检查空间并清理确认无用的残留，保留上一版构建和源码/数据库备份。不要重跑 .tmp/deploy-personal-review.sh 原地构建脚本。

### 成员交付与 GitHub 真实推送（2026-11-08）

- 用户确认已完成成员交互和交付。SHENWEI-INTERACT-1108B 的任务分支已合并到 main；仓库文件为 README.md 与 deliveries/cmw7llbxs0009v6tpno652zsx.md。
- 项目专用 Ed25519 部署密钥保存在服务器，用户在指定 GitHub 仓库启用写权限。通过 ssh.github.com:443 严格验证固定官方主机公钥；仅创建者可创建密钥、检查远程和推送。Git 子进程不继承模型凭据。
- 新增回归覆盖真实临时 Git 仓库的推送、本地/远程提交变化、脏工作区拒绝和错误脱敏；隔离 MySQL 覆盖成员对密钥/检查/推送操作的权限边界，浏览器夹具覆盖确认后才推送和成功状态。Playwright 本次记录 passed、失败列表为空；隔离库 scenarioforge_test_git_sync_20261108 和账号 sf_git_sync_1108 清理后数量为零。
- 原 GitHub 初始化提交仅含 README 标题，经检查后通过独立工作区合并保留双边历史；没有强推。最终提交 0fdda327e0f0aaa259dab5a573fd3739ce9c8ebe。nayun 在生产网页确认推送后，17:33:44 显示“已同步到 GitHub”“远程与本地 main 一致”。截图 docs/evidence/git-push-success-20261108.jpg。
- Linux webpack 最终构建成功，发布 git-sync-20261108T093232Z；Web/MCP/MySQL active，首页 HTTP 200，工作区干净。备份和回滚位置详见 D:\5\handoff.md 第 19 节；本轮无新增迁移、依赖或真实模型调用。
- 当前只完成 Markdown 交付同步，不代表通用代码开发、仓库拉取/冲突解决、自动执行测试或外部 MCP 已完成。磁盘余约 2.9 GiB（95% 已用），下次发布前检查空间；自动备份与恢复演练仍待完成。
