import { z } from "zod";
import { answerQuestion } from "@/lib/clarifications";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin, readJson } from "@/lib/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const body = z.object({ clarificationId: z.string().max(150), answer: z.union([z.string().min(1).max(5000), z.array(z.string().min(1).max(500)).min(1).max(10)]) }).parse(await readJson(request));
    return Response.json(await answerQuestion(id, body.clarificationId, body.answer));
  } catch (error) { return errorResponse(error); }
}
