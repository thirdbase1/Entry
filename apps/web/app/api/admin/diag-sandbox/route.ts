/**
 * One-off admin diagnostic (2026-07-16): exercises the REAL direct-chat
 * sandbox path (lib/direct-chat/sandbox.ts) end to end, inside the
 * deployed function itself where E2B_API_KEY actually resolves (it's a
 * Vercel "sensitive" var — unobtainable from any local shell or CLI, so
 * this is the only way to prove the E2B rewrite works against the real
 * production credential). Runs a real `bash` command through a real E2B
 * sandbox, using a throwaway chatId so it doesn't touch any real user's
 * ChatSandbox row. Safe to leave in permanently alongside the other
 * admin/diag-* routes — creates one ephemeral E2B sandbox per call.
 *
 * GET -- admin/bearer only, same pattern as admin/errors.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';
import { getSandboxForChat, getPreviewForChat } from '@/lib/direct-chat/sandbox';
import { prisma } from '@entry/db';

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (bearerOk) return true;
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return false;
  return featureService.isAdmin(session.user.id);
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Optional ?chatId=... reproduces a REAL chat's exact preview-route
  // path (same functions [sessionId]/preview/route.ts calls) against its
  // real, persisted ChatSandbox row -- for confirming a specific reported
  // chat is actually fixed, not just that the mechanism works in the
  // abstract. Falls back to a disposable throwaway id (cleaned up after)
  // when omitted.
  const url = new URL(req.url);
  const realChatId = url.searchParams.get('chatId');
  const chatId = realChatId ?? `diag-sandbox-${Date.now()}`;
  const start = Date.now();
  try {
    const sandbox = await getSandboxForChat(chatId);
    const bootMs = Date.now() - start;

    const bashStart = Date.now();
    const result = await sandbox.run({ command: 'echo "hello-from-e2b-verify" && python3 --version && node --version' });
    const bashMs = Date.now() - bashStart;

    const preview = await getPreviewForChat(chatId);

    let browser: { exitCode: number; stdout: string; stderr: string; ms: number } | undefined;
    if (url.searchParams.get('testBrowser') === '1') {
      const browserStart = Date.now();
      // Matches the real invocation shape used by lib/tool-impls/browser_use.ts
      // (`agent-browser --session <id> <action> ...`), not a guess.
      const session = `diag-${Date.now()}`;
      const browserResult = await sandbox.run({
        command: `agent-browser --session ${session} open 'https://example.com'`,
      });
      browser = {
        exitCode: browserResult.exitCode,
        stdout: browserResult.stdout,
        stderr: browserResult.stderr,
        ms: Date.now() - browserStart,
      };
    }

    return NextResponse.json({
      ok: true,
      chatId,
      sandboxId: sandbox.id,
      bootMs,
      bashMs,
      bash: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
      preview,
      browser,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, chatId, name: err?.name, message: err?.message, stack: err?.stack?.split('\n').slice(0, 5) },
      { status: 500 },
    );
  } finally {
    // Only clean up the throwaway row -- never touch a real chat's
    // persisted ChatSandbox row.
    if (!realChatId) {
      await prisma.chatSandbox.deleteMany({ where: { chatId } }).catch(() => {});
    }
  }
}
