/**
 * One-off admin diagnostic (2026-07-17): reproduces the EXACT real
 * production failure ("controlling model kept returning invalid
 * responses") end-to-end -- real Steel session, real navigation to the
 * real failing URL, real page innerText + real screenshot, then calls
 * the real decideSteelAction (with its plain-text fallback) against the
 * user's real resolved BYOK model. The isolated diag-toolcall probes
 * used a tiny synthetic prompt and passed; this exists because that
 * wasn't enough -- the user correctly pushed back that it was still
 * failing on real page content in production, so this gets the real raw
 * model output instead of guessing why.
 *
 * POST { byokModelId, userId, url, waitMs } -- bearer ADMIN_DEBUG_TOKEN only.
 */
import { createSteelSession, connectSteelBrowser, stopSteelSession } from '@entry/agent/lib/steel-client';
import { decideSteelAction } from '@entry/agent/tool-impls/browser_use';
import { resolveByokModel } from '@/lib/byok/resolve-model';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { byokModelId, userId, url, waitMs } = (await req.json()) as {
    byokModelId?: string;
    userId?: string;
    url?: string;
    waitMs?: number;
  };
  if (!byokModelId || !userId || !url) {
    return Response.json({ error: 'byokModelId, userId, url are required' }, { status: 400 });
  }

  const { model } = await resolveByokModel(byokModelId, userId);

  const session = await createSteelSession();
  try {
    const browser = await connectSteelBrowser(session.websocketUrl);
    const context = browser.contexts()[0];
    const pages = context.pages();
    const page = pages.length ? pages[0] : await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(waitMs ?? 10_000);

    const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const screenshotBuf = await page.screenshot({ timeout: 5000 }).catch(() => Buffer.from(''));
    const screenshotBase64 = screenshotBuf.toString('base64');

    const decision = await decideSteelAction({
      llmModel: model,
      task: `Navigate to ${url}. Just go to that URL and wait 10 seconds. Then take a screenshot and tell me the page title and what you see.`,
      history: [],
      pageText,
      url: page.url(),
      tabCount: pages.length,
      screenshotBase64,
    });

    return Response.json({
      decision,
      realPageTextLength: pageText.length,
      realPageTextPreview: pageText.slice(0, 1000),
      realScreenshotBase64Length: screenshotBase64.length,
    });
  } finally {
    await stopSteelSession(session.id).catch(() => {});
  }
}
