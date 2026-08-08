/**
 * One-off bearer-gated diagnostic (2026-08-09): the OTP sign-in email
 * shows "sent" (no console.error in packages/mail's sendMail, meaning
 * SendByte returned a truthy `result.id`) but the email never actually
 * arrives in the recipient's inbox or spam folder. Need to see the RAW
 * SendByte response, not just whether `.id` was truthy, to find out
 * if it's silently accepting-but-dropping (unverified from-domain,
 * sandbox-mode key, etc). Gated the same way as bootstrap-admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SendByte } from '@sendbyte/node';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { to } = await req.json();
  if (!to || typeof to !== 'string') {
    return NextResponse.json({ error: 'to is required' }, { status: 400 });
  }

  const apiKey = process.env.SENDBYTE_API_KEY;
  const from = process.env.SENDBYTE_FROM_DOMAIN ?? 'Entry <noreply@entry.io>';

  if (!apiKey) {
    return NextResponse.json({ error: 'SENDBYTE_API_KEY not set' }, { status: 400 });
  }

  const sendbyte = new SendByte(apiKey);

  try {
    const result = await sendbyte.emails.send({
      from,
      to,
      subject: 'Entry sendbyte-diag test',
      html: '<p>Diagnostic test email.</p>',
    });

    return NextResponse.json({
      success: true,
      from,
      apiKeyPrefix: apiKey.slice(0, 8),
      apiKeyLength: apiKey.length,
      rawResult: result,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        from,
        apiKeyPrefix: apiKey.slice(0, 8),
        apiKeyLength: apiKey.length,
        error: (e as Error).message,
        errorStack: (e as Error).stack,
      },
      { status: 200 }
    );
  }
}
