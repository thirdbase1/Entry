import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { userFeatureModel } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/**
 * One-off admin cleanup (owner ask 2026-07-26: "make sure only
 * benjijules258@gmail.com is admin"): finds every user currently holding
 * the 'administrator' UserFeature and deactivates it on everyone except
 * the one email passed in `keepEmail`. Idempotent -- safe to call again.
 */
export async function POST(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { keepEmail } = await req.json();
  if (!keepEmail || typeof keepEmail !== 'string') {
    return NextResponse.json({ error: 'keepEmail is required' }, { status: 400 });
  }

  const keepUser = await prisma.user.findUnique({ where: { email: keepEmail } });
  if (!keepUser) return NextResponse.json({ error: `No user found with email ${keepEmail}` }, { status: 404 });

  const admins = await prisma.userFeature.findMany({
    where: { name: 'administrator', activated: true },
    select: { userId: true },
    distinct: ['userId'],
  });

  const removed: string[] = [];
  let keptWasAlreadyAdmin = false;
  for (const a of admins) {
    if (a.userId === keepUser.id) {
      keptWasAlreadyAdmin = true;
      continue;
    }
    await userFeatureModel.removeUserFeature(a.userId, 'administrator');
    const u = await prisma.user.findUnique({ where: { id: a.userId }, select: { email: true } });
    removed.push(u?.email ?? a.userId);
  }

  if (!keptWasAlreadyAdmin) {
    await userFeatureModel.addUserFeature(keepUser.id, 'administrator', 'enforce-single-admin');
  }

  return NextResponse.json({ ok: true, kept: keepEmail, removedAdminFrom: removed });
}
