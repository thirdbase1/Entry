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
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
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

  const throwawayChatId = `diag-sandbox-${Date.now()}`;
  const start = Date.now();
  try {
    const sandbox = await getSandboxForChat(throwawayChatId);
    const bootMs = Date.now() - start;

    const bashStart = Date.now();
    const result = await sandbox.run({ command: 'echo "hello-from-e2b-verify" && python3 --version && node --version' });
    const bashMs = Date.now() - bashStart;

    return NextResponse.json({
      ok: true,
      sandboxId: sandbox.id,
      bootMs,
      bashMs,
      bash: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, name: err?.name, message: err?.message, stack: err?.stack?.split('\n').slice(0, 5) },
      { status: 500 },
    );
  } finally {
    // Clean up the throwaway ChatSandbox row this created, since
    // throwawayChatId is not a real chat.
    await prisma.chatSandbox.deleteMany({ where: { chatId: throwawayChatId } }).catch(() => {});
  }
}
