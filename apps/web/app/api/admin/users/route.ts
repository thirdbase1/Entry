import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest, userModel } from '@entry/auth';
import { featureService, userFeatureModel } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/**
 * GET /api/admin/users?skip=0&first=20&email=foo@bar.com
 * List registered users (admin only).
 * Ported 1:1 from the original's UserManagementResolver.users.
 *
 * There is no `role` column on User — admin status is a feature flag
 * (`administrator`, checked via featureService.isAdmin), matching the
 * original's UserFeature-based admin gate.
 *
 * 2026-07-21: also accepts the ADMIN_DEBUG_TOKEN bearer (same pattern as
 * /api/admin/errors) so this is reachable out-of-band via curl for
 * one-off account lookups, not just from a logged-in admin's browser.
 */
export async function GET(req: NextRequest) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const isAdmin = await featureService.isAdmin(session.user.id);
    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const url = new URL(req.url);
  const skip = parseInt(url.searchParams.get('skip') || '0', 10);
  const first = parseInt(url.searchParams.get('first') || '20', 10);
  const email = url.searchParams.get('email');

  const where = email ? { email: { contains: email, mode: 'insensitive' as const } } : {};

  const [users, count] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: first,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        disabled: true,
        createdAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  return NextResponse.json({
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      image: u.image,
      emailVerified: u.emailVerified,
      disabled: u.disabled,
      createdAt: u.createdAt,
      hasPassword: false, // Better Auth stores passwords in Account table
    })),
    count,
  });
}

/**
 * POST /api/admin/users
 * Create a new user (admin only).
 * Ported 1:1 from the original's UserManagementResolver.createUser.
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  if (!body.email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  try {
    const newUser = await userModel.createUser(
      { email: body.email, name: body.name || body.email.split('@')[0] }
    );
    await userModel.updateUser(newUser.id, { registered: true });
    void userFeatureModel.addUserFeature(newUser.id, "free_plan_v1" as any, "admin-created");

    return NextResponse.json(
      {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        image: newUser.image,
        emailVerified: newUser.emailVerified,
        disabled: newUser.disabled,
      },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'User already exists' }, { status: 409 });
  }
}
