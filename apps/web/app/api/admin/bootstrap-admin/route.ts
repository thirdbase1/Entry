/**
 * One-off bootstrap: grants the 'administrator' feature to a user by
 * email via ADMIN_DEBUG_TOKEN bearer (owner ask 2026-07-26 — HCNSec
 * Relay seeding was blocked on "No admin user found to own the shared
 * provider row" because no User had ever been marked administrator yet).
 * Every other admin write route requires an existing admin SESSION to
 * grant more admins — a chicken-and-egg problem for the very first one.
 * This is that one-time bootstrap, gated the same way every other
 * bearer-only diag route already is (isAdminBearerAuthorized).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { userFeatureModel } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { email } = await req.json();
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: `No user found with email ${email}` }, { status: 404 });

  const already = await userFeatureModel.hasUserFeature(user.id, 'administrator');
  if (!already) {
    await userFeatureModel.addUserFeature(user.id, 'administrator', 'bootstrap-admin');
  }

  return NextResponse.json({ success: true, userId: user.id, email: user.email, alreadyAdmin: already });
}
