import logging

from fastmcp import FastMCP

from config import required
from search_ddgs import search_ddgs
from tools.research import create_research_package, search_scenario
from tools.files import generate_workspace, read_workspace_file, write_workspace_file, export_workspace, update_file_plan
from tools.clarifications import ask_user, get_user_answers
from tools.evidence import get_research_package, search_evidence, get_evidence, get_file_context, answer_user

logging.basicConfig(level=logging.INFO)
mcp = FastMCP("ScenarioForge", instructions="先研究再创作。工具仅访问当前研究包，不提供 shell 或任意文件系统访问。")
mcp.tool(create_research_package)
mcp.tool(search_scenario)
mcp.tool(generate_workspace)
mcp.tool(update_file_plan)
mcp.tool(read_workspace_file)
mcp.tool(write_workspace_file)
mcp.tool(export_workspace)
mcp.tool(ask_user)
mcp.tool(get_user_answers)
mcp.tool(get_research_package)
mcp.tool(search_evidence)
mcp.tool(get_evidence)
mcp.tool(get_file_context)
mcp.tool(answer_user)
mcp.tool(write_workspace_file, name="update_workspace_file")
mcp.custom_route("/internal/search/ddgs", methods=["POST"], include_in_schema=False)(search_ddgs)

if __name__ == "__main__":
    token = required("SCENARIOFORGE_INTERNAL_TOKEN")
    if len(token) < 32:
        raise ValueError("SCENARIOFORGE_INTERNAL_TOKEN 至少需要 32 个字符。")
    mcp.run(transport="streamable-http", host="127.0.0.1", port=8000, path="/mcp", show_banner=False)
