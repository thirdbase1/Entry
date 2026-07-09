import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';
import { SendByte } from '@sendbyte/node';

/**
 * POST /api/admin/mail/test
 * Ported 1:1 from MailResolver.sendTestEmail (@Admin()-guarded mutation).
 * Admin status is a feature flag (`featureService.isAdmin`), not a `role`
 * column — the schema has no `role` field on User (ported 1:1 from the
 * original, which gates admin via the same UserFeature mechanism).
 *
 * Mail transport was swapped to SendByte (see packages/mail — provider
 * change, at the user's request, from the originally-planned Resend).
 * SendByte is a single API-key REST service, not per-request SMTP config,
 * so this sends a real test email through the configured
 * SENDBYTE_API_KEY/SENDBYTE_FROM_DOMAIN to the calling admin's own address —
 * same intent (verify mail is actually configured and delivering) adapted
 * to the new provider's shape.
 *
 * Body: {} (no config needed — reads from env, unlike the original's
 * per-request SMTP config, since SendByte is configured once at the
 * package level)
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  const apiKey = process.env.SENDBYTE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Failed to verify your mail configuration. Cause: SENDBYTE_API_KEY is not set.' },
      { status: 400 }
    );
  }

  const from = process.env.SENDBYTE_FROM_DOMAIN ?? 'Entry <noreply@entry.io>';
  const sendbyte = new SendByte(apiKey);

  try {
    await sendbyte.emails.send({
      from,
      to: session.user.email,
      subject: 'Entry test email',
      html: '<p>This is a test email from your Entry server. If you received this, your mail configuration is working.</p>',
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to send test email. Cause: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true });
}
