import { requireFile } from "@/lib/files";
import { getResearch } from "@/lib/research";
import { errorResponse } from "@/lib/errors";
import { saveUserFile, updateFileLock } from "@/lib/editing";
import { assertSameOrigin, readJson } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string; filename: string }> }) {
  try {
    const { id, filename } = await context.params;
    await getResearch(id);
    const file = await requireFile(id, filename);
    return new Response(file.content, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string; filename: string }> }) {
  try {
    assertSameOrigin(request);
    const { id, filename } = await context.params;
    await getResearch(id);
    return Response.json(await saveUserFile(id, filename, await readJson(request)));
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; filename: string }> }) {
  try {
    assertSameOrigin(request);
    const { id, filename } = await context.params;
    await getResearch(id);
    return Response.json(await updateFileLock(id, filename, await readJson(request)));
  } catch (error) { return errorResponse(error); }
}
