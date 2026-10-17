# ScenarioForge MCP Server

Python FastMCP 服务，使用 Streamable HTTP，默认地址为 `http://localhost:8000/mcp`，仅监听本机。

RAG 扩展新增 `get_research_package`、`search_evidence`、`get_evidence`、`get_file_context`、`answer_user` 和 `update_workspace_file`（写入别名）。统一使用 package_id；详细参数、引用校验、CLI、独立 Embedding 配置及迁移见 [RAG 说明](../docs/RAG.md)。独立创建研究包异步排队，已有包复用计划；RAG 按文件先检索再生成。

## 启动

1. 安装 Python 3.11+ 和 uv：`python -m pip install uv`。
2. 在项目根目录创建 `.env.local`，配置模型、SEARCH_PROVIDER 以及至少 32 字符的 `SCENARIOFORGE_INTERNAL_TOKEN`。默认 mock 无需搜索 key，仅 tavily 需要 TAVILY_API_KEY。
3. 先启动 Next.js（数据库读写通过其内部 API 完成）。
4. 在本目录执行 `uv sync`，然后 `uv run main.py`。

服务从项目根目录加载 `.env.local`，与 Next.js 使用同一份配置。内部 Token 仅用于服务之间的调用，不暴露到前端。

模型 key、API 地址、API 模式、模型名及请求超时优先使用 `.env.local` 中的值，覆盖系统同名变量；空项目 key 不会回退系统 key。`SCENARIOFORGE_ENV_FILE` 可显式选择独立模型配置文件，空字符串用于只读取进程环境的隔离测试。

## 研究工具

- `create_research_package`：创建或复用研究包，生成研究问题，并公布带用途、优先级、内容要点的文件计划。
- `update_file_plan`：追加新主题的文件或更新说明，保留已有计划条目；必须先公布计划再生成。
- `search_scenario`：通过 Next.js 统一 Search Provider 查询，去重并生成带来源的证据卡；Mock 数据明确标记为未验证。
- `generate_workspace`：综合证据，按动态文件计划生成并保存文档；保留用户已编辑的文件。
- `ask_user` / `get_user_answers`：提问、读取答案与超时处理。
- `read_workspace_file` / `write_workspace_file`：读取和按版本写入，遵守锁和用户原文保护。
- `export_workspace`：返回 ZIP 下载地址及文件清单。

独立调用创建工具时省略 `package_id` 并提供 `goal`；后端 Agent 调用时只传入当前 `package_id`，目标、约束和上传资料均从已保存的研究包读取。

检索工具使用 `question_index`（已保存 `researchQuestions` 数组的下标，从 0 开始），由后端读取问题原文。已完成的问题直接复用证据，不再次调用模型或扣搜索额度，即使已达到 12 次上限也能继续生成文件。旧调用仍可传与计划完全一致的 `question`；改写后的问题会返回计划中的编号供纠正，不扣额度。

模型与搜索调用在工具执行时校验凭据，服务可在没有模型凭据时启动并检查工具清单。

DDGS 采用内部 HTTP endpoint：`POST /internal/search/ddgs`，与 `/mcp` 同端口。请求带 `Authorization: Bearer <SCENARIOFORGE_INTERNAL_TOKEN>`，JSON 为 `{ "query": "Tokyo rental rules", "maxResults": 5 }`。仅通过 Next.js 的 DDGS Provider 调用，不作为 Agent 专用工具暴露。

Python 使用 `ddgs` 的 DuckDuckGo backend，输出统一 SearchResult；安装依赖后重启服务。空结果、限流、超时和无效响应返回结构化错误，不伪造数据。Provider 选择和 SearXNG/Tavily/Mock 实现均在 Next.js，Python 研究工具不依赖具体搜索服务。

默认必须生成 README.md、RESEARCH.md、SOURCES.md（required）；其他 Markdown 按场景选择，每份职责明确，不凑数量或重复内容。优先级支持 required / recommended / optional，计划中的全部条目均为实际选定的输出；完成检查不依赖固定文件数量。

## Inspector

执行 `npx @modelcontextprotocol/inspector`，选择 Streamable HTTP 并连接 `http://localhost:8000/mcp`。先检查工具清单，再在配置好真实 API key 后调用工具。网页流程还需要 Next.js 同时运行。

命令行检查：

```powershell
npx @modelcontextprotocol/inspector --cli http://localhost:8000/mcp --transport http --method tools/list
```

在根目录执行 `mcp-server\.venv\Scripts\python.exe scripts/check_llm.py` 可验证 Python 模型适配器的两种 API 模式和无效 JSON 修正。该检查不访问外部模型。
