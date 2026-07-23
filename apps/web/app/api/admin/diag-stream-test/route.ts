/** TEMPORARY diagnostic (2026-07-23): emits 8 SSE events, 1s apart, each
 * timestamped server-side, using the EXACT same content-type + headers as
 * the AI SDK's real createUIMessageStreamResponse (text/event-stream,
 * x-accel-buffering: no, etc -- see node_modules/ai/dist/index.js's
 * UI_MESSAGE_STREAM_HEADERS) to verify whether Cloudflare + Render's proxy
 * chain delivers real SSE chunks incrementally or buffers the whole
 * response. Bearer ADMIN_DEBUG_TOKEN only. Safe to delete after use. */
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function GET(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 8; i++) {
        controller.enqueue(encoder.encode(`data: chunk ${i} at server-time ${Date.now()}\n\n`));
        await new Promise(r => setTimeout(r, 1000));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
