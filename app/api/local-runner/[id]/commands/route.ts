import { z } from "zod";
import { ApiError, errorResponse } from "@/lib/errors";
import { db } from "@/lib/db";
import { authorizeRunner, claimRunnerCommand, completeRunnerCommand, confirmRunnerCommand, registerRunnerDirectory } from "@/lib/workspace-agent/local-runner";
import { readJson } from "@/lib/validation";
import { runnerDirectory } from "@/lib/local-runner/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ") || value.length > 256) throw new ApiError(401, "Runner 需要有效令牌。");
  return value.slice(7);
}
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const runner = await authorizeRunner(id, bearer(request));
    const command = await claimRunnerCommand(runner.id);
    return Response.json({ command }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params, token = bearer(request);
    const body = z.object({ workspaceDirectory: runnerDirectory }).strict().parse(await readJson(request, 4096));
    await registerRunnerDirectory(id, token, body.workspaceDirectory);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const runner = await authorizeRunner(id, bearer(request));
    const body = z.object({ action: z.enum(["start", "confirm", "complete"]).default("complete"), commandId: z.string().min(1).max(100), leaseOwner: z.string().min(1).max(100), result: z.unknown().optional(), error: z.string().max(500).optional() }).parse(await readJson(request, 2_000_000));
    if (body.action !== "complete") {
      await confirmRunnerCommand(runner.id, body.commandId, body.leaseOwner, body.action === "start");
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const delivered = await db.localRunnerCommand.findFirst({ where: { id: body.commandId, runnerId: runner.id, leaseOwner: body.leaseOwner, status: { in: ["completed", "consumed"] } }, select: { id: true } });
    if (delivered) return Response.json({ ok: true });
    const command = await db.localRunnerCommand.findFirst({ where: { id: body.commandId, runnerId: runner.id, status: { in: ["claimed", "executing"] }, leaseOwner: body.leaseOwner, execution: { runnerId: runner.id, status: "running", leaseUntil: { gt: new Date() } } }, include: { execution: { select: { leaseOwner: true } } } });
    if (!command || command.executionLease !== command.execution.leaseOwner) throw new ApiError(404, "Runner 命令不存在或任务已停止。");
    await completeRunnerCommand(runner.id, body.commandId, body.leaseOwner, body.result, body.error);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
