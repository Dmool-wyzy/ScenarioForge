import { z } from "zod";
import { errorResponse } from "@/lib/errors";
import { exchangeRunnerPairing } from "@/lib/workspace-agent/local-runner";
import { readJson } from "@/lib/validation";
import { runnerDirectory } from "@/lib/local-runner/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const body = z.object({ code: z.string().length(72), workspaceDirectory: runnerDirectory.optional() }).parse(await readJson(request, 4096));
    return Response.json(await exchangeRunnerPairing(body.code, body.workspaceDirectory), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
