/**
 * One-off admin diagnostic (2026-07-17): runs the REAL browserUse tool
 * `execute` (the exact production code path -- pickFreeLane, real DB
 * session rows, real runSteelLane/runBrightDataLane/runBrowserUseLane,
 * real multi-step decide loop) N times for a given provider, using a
 * synthetic-but-isolated chatId per run so lanes never collide with the
 * user's real chat sessions. Explicit user request: "complete the whole
 * base44 task 3 times using each provider" -- verifying the schema fix
 * (see decideSteelAction's SteelActionSchema) holds up across full,
 * real, multi-step runs, not just a single decision like diag-steel-live.
 *
 * POST { byokModelId, userId, provider, runs, task, timeoutMs } -- bearer
 * ADMIN_DEBUG_TOKEN only. Always calls browserStop after each run so no
 * live session is left running/billing.
 */
import { browserUse } from '@entry/agent/tool-impls/browser_use';
import { browserStop } from '@entry/agent/tool-impls/browser_stop';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import type { ToolExecCtx } from '@entry/agent/tool-impls/types';

export const maxDuration = 300;

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { byokModelId, userId, provider, runs, task } = (await req.json()) as {
    byokModelId?: string;
    userId?: string;
    provider?: 'browser_use' | 'steel' | 'brightdata';
    runs?: number;
    task?: string;
  };
  if (!byokModelId || !userId || !provider) {
    return Response.json({ error: 'byokModelId, userId, provider are required' }, { status: 400 });
  }

  const { model: byokModel } = await resolveByokModel(byokModelId, userId);
  const runCount = runs ?? 3;
  const taskText =
    task ??
    'Go to https://app.base44.com/register. Fill the registration form with a test email and password. If you see a ' +
      'CAPTCHA or "Please complete the security verification" message, wait for it and try once more, then report ' +
      'what happened either way.';

  const results: Array<Record<string, unknown>> = [];

  for (let run = 1; run <= runCount; run++) {
    const chatId = `diag-stress-${provider}-${Date.now()}-${run}`;
    const ctx: ToolExecCtx = {
      session: { id: chatId, auth: { current: { principalId: userId } } },
      byokModel,
      getSandbox: async () => {
        throw new Error('getSandbox not used by browser_use');
      },
    };

    const startedAt = Date.now();
    try {
      const result = await browserUse.execute({ task: taskText, provider }, ctx);
      const elapsedMs = Date.now() - startedAt;
      const sessionId = (result as { sessionId?: string }).sessionId;
      // Always stop the session afterwards -- this is a throwaway test run,
      // never leave a real cloud browser billing/running.
      if (sessionId) {
        await browserStop.execute({ session_id: sessionId }, ctx).catch(() => {});
      }
      results.push({ run, ok: true, elapsedMs, result });
    } catch (err) {
      results.push({
        run,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({ provider, runCount, results });
}
