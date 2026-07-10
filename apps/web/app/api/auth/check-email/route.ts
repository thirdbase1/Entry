import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';

const QuerySchema = z.object({ email: z.string().email() });

/**
 * GET /api/auth/check-email?email=...
 * Public (no auth) — the sign-in page's first step needs to know, before
 * showing any password/OTP UI, whether this email already has a
 * credential (password) account so it can route to the password step vs
 * straight to a one-time code. Previously this was a hardcoded stub on the
 * client (`{ hasPassword: true, canSignIn: true }` for every email, always)
 * which meant the OTP/sign-in path could never be reached from the main
 * screen for any user, ever — this replaces it with a real lookup.
 *
 * Does not leak whether the account exists at all beyond hasPassword/
 * canSignIn — both default to permissive-for-non-existent-user values
 * (hasPassword: false so a brand-new email goes straight to the OTP path,
 * which also handles signup since Better Auth's emailOTP plugin creates
 * the user on first successful verify when disableSignUp is false).
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const parsed = QuerySchema.safeParse({ email: req.nextUrl.searchParams.get('email') });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      disabled: true,
      accounts: { where: { providerId: 'credential' }, select: { password: true } },
    },
  });

  if (!user) {
    return NextResponse.json({ hasPassword: false, canSignIn: true });
  }

  return NextResponse.json({
    hasPassword: user.accounts.some(a => !!a.password),
    canSignIn: !user.disabled,
  });
});
