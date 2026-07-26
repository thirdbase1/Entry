import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { userFeatureModel } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/** One-off admin grant (owner ask 2026-07-26): promote a single email to
 *  admin. Purely additive -- does NOT touch anyone else's admin status. */
export async function POST(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { email } = await req.json();
  if (!email || typeof email !== 'string') return NextResponse.json({ error: 'email is required' }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: `No user found with email ${email}` }, { status: 404 });

  const already = await prisma.userFeature.findFirst({ where: { userId: user.id, name: 'administrator', activated: true } });
  if (already) return NextResponse.json({ ok: true, alreadyAdmin: true, email });

  await userFeatureModel.addUserFeature(user.id, 'administrator', 'owner-requested-promotion');
  return NextResponse.json({ ok: true, promoted: email });
}
