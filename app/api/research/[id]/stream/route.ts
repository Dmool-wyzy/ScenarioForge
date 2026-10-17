import { db } from "@/lib/db";
import { getResearch } from "@/lib/research";
import { errorResponse, logError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await getResearch(id);
    const supplied = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
    let cursor = /^\d{1,12}$/.test(supplied) ? Number(supplied) : 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let count = 0;
        const close = () => { if (!stopped) { stopped = true; clearTimeout(timer); controller.close(); } };
        request.signal.addEventListener("abort", close, { once: true });
        const poll = async () => {
          try {
            const events = await db.researchEvent.findMany({ where: { packageId: id, sequence: { gt: cursor } }, orderBy: { sequence: "asc" }, take: 100 });
            if (stopped) return;
            for (const event of events) {
              controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, payload: event.payload ? JSON.parse(event.payload) : null })}\n\n`));
              cursor = event.sequence;
            }
            if (++count % 15 === 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            timer = setTimeout(poll, 1000);
          } catch (error) { logError(error); close(); }
        };
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        void poll();
      },
      cancel() { stopped = true; clearTimeout(timer); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) { return errorResponse(error); }
}
