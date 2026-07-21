/** One-off admin diagnostic (2026-07-21): replicate the EXACT production
 * /api/direct/chat call path for one saved BYOK model -- resolveByokModel
 * + one real streamText call -- and return the real success/failure,
 * instead of relying on the settings page's separate "Test connection"
 * button (which may not exercise the identical code path). Bearer
 * ADMIN_DEBUG_TOKEN only, read/network side-effect only (one real
 * provider call), no persistence. */
import { isAdminBearerAuthorized } from '@/lib/admin-auth';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId, byokModelId } = (await req.json()) as { userId?: string; byokModelId?: string };
  if (!userId || !byokModelId) return Response.json({ error: 'userId and byokModelId required' }, { status: 400 });

  try {
    const resolved = await resolveByokModel(byokModelId, userId);

    const uiMessages: UIMessage[] = [
      { id: 'diag-1', role: 'user', parts: [{ type: 'text', text: 'Reply with exactly the word: pong' }] } as any,
    ];

    const result = streamText({
      model: resolved.model,
      messages: await convertToModelMessages(uiMessages),
      timeout: { chunkMs: 60_000, stepMs: 60_000 } as any,
    });

    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
    }
    const finishReason = await result.finishReason;
    const usage = await result.usage;

    return Response.json({
      ok: true,
      providerLabel: resolved.providerLabel,
      modelId: resolved.modelId,
      text,
      finishReason,
      usage,
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      errorMessage: err?.message || String(err),
      errorName: err?.name,
      cause: err?.cause ? String(err.cause) : undefined,
      responseBody: err?.responseBody || err?.data?.responseBody,
      statusCode: err?.statusCode,
      url: err?.url,
    }, { status: 200 });
  }
}
