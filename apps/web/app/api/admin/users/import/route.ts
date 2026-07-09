import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest, userModel } from '@entry/auth';
import { featureService, userFeatureModel } from '@entry/features';

/**
 * POST /api/admin/users/import
 * Import multiple users (admin only).
 * Ported 1:1 from the original's UserManagementResolver.importUsers.
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
  const users: { email: string; name?: string }[] = body.users || [];

  const results = await Promise.allSettled(
    users.map(async u => {
      const newUser = await userModel.createUser(
        { email: u.email, name: u.name || u.email.split('@')[0] }
      );
      await userModel.updateUser(newUser.id, { registered: true });
      void userFeatureModel.addUserFeature(newUser.id, "free_plan_v1" as any, "admin-import");
      return newUser;
    })
  );

  return NextResponse.json(
    results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return { id: result.value.id, email: result.value.email, name: result.value.name };
      }
      return {
        email: users[i].email,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
      };
    })
  );
}
