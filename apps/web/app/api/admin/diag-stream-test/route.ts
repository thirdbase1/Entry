/** TEMPORARY diagnostic (2026-07-23): emits 8 chunks, 1s apart, each
 * timestamped server-side, over a real streaming Response with the exact
 * same anti-buffering headers as /api/direct/chat. Used once to verify
 * whether Cloudflare + Render's proxy chain delivers chunks incrementally
 * in near-real-time or buffers/holds the whole response until it's done.
 * Bearer ADMIN_DEBUG_TOKEN only. Safe to delete after use -- no other
 * code depends on this route. */
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function GET(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 8; i++) {
        controller.enqueue(encoder.encode(`chunk ${i} at server-time ${Date.now()}\n`));
        await new Promise(r => setTimeout(r, 1000));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
