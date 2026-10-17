import { MCPServerStreamableHttp } from "@openai/agents";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const [command, packageId, ...args] = process.argv.slice(2);
const client = new MCPServerStreamableHttp({ name: "scenarioforge-cli", url: process.env.SCENARIOFORGE_MCP_URL || "http://localhost:8000/mcp", timeout: 660000, errorFunction: null });
try {
  await client.connect();
  async function call(name, parameters) {
    const result = await client.callToolResult(name, parameters);
    if (result.isError) throw new Error(result.content.filter(row => row.type === "text").map(row => row.text).join("\n"));
    return result.structuredContent ?? JSON.parse(result.content.find(row => row.type === "text").text);
  }
  let result;
  if (command === "create") result = await call("create_research_package", { goal: [packageId, ...args].join(" ") });
  else if (command === "get" && packageId) result = await call("get_research_package", { package_id: packageId });
  else if (command === "search" && packageId) result = await call("search_evidence", { package_id: packageId, query: args.join(" ") });
  else if (command === "evidence" && packageId) result = await call("get_evidence", { package_id: packageId, evidence_id: args[0] });
  else if (command === "clarify" && packageId) {
    const snapshot = await call("get_research_package", { package_id: packageId });
    const questions = snapshot.clarifications.filter(row => ["waiting", "blocked"].includes(row.status));
    if (!questions.length) stdout.write("暂无等待回答的问题。\n");
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      for (const row of questions) {
        stdout.write(`\n[${row.priority}] ${row.question}\n${row.whyNeeded}\n`);
        if (row.options) stdout.write(row.options.map((option, index) => `${index + 1}. ${option}`).join("\n") + "\n");
        if (row.defaultAssumption) stdout.write(`未确认默认假设：${row.defaultAssumption}\n`);
        const value = await readline.question("回答（空行跳过，多选用逗号分隔序号）：");
        if (!value.trim()) continue;
        const answer = row.type === "multi_choice" ? value.split(/[,，]/).map(index => row.options[Number(index.trim()) - 1]) : row.type === "single_choice" ? row.options[Number(value.trim()) - 1] : value;
        if (answer == null || (Array.isArray(answer) && answer.some(value => value == null))) throw new Error("选项序号无效。");
        await call("answer_user", { package_id: packageId, clarification_id: row.id, answer });
      }
    } finally { readline.close(); }
    result = await call("get_research_package", { package_id: packageId });
  } else throw new Error('用法：npm run cli -- create "目标" | get <packageId> | search <packageId> "问题" | evidence <packageId> EVIDENCE-1 | clarify <packageId>');
  if (result) stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) { process.stderr.write((error instanceof Error ? error.message : "CLI 调用失败") + "\n"); process.exitCode = 1; }
finally { await client.close(); }
