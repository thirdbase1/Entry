/**
 * POST /api/user/wishlist
 * Submit an email to the wishlist/waitlist.
 * Ported 1:1 from UserResolver.submitWishlist — this is a @Public()
 * mutation in the original (no auth required, just rate-limited and
 * email-validated), backed by the real `Wishlist` model (email is the PK;
 * duplicate submit is caught as a unique-constraint violation, reported
 * as `false`, not an error).
 *
 * Body: { email: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const { email } = await req.json();

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  try {
    await prisma.wishlist.create({ data: { email } });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return NextResponse.json({ success: false });
    }
    throw e;
  }
}
