/**
 * PATCH /api/admin/users/[id]/features
 * Update a user's enabled features.
 * Ported 1:1 from FeaturesResolver.updateUserFeatures.
 *
 * Body: { features: string[] }  — must be valid FeatureNameKey values
 *   ('administrator' | 'early_access' | 'unlimited_copilot' | 'free_plan_v1' | 'pro_plan_v1')
 * Requires admin authentication.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService, userFeatureModel, type FeatureNameKey } from '@entry/features';

const VALID_FEATURES: FeatureNameKey[] = [
  'administrator',
  'early_access',
  'unlimited_copilot',
  'free_plan_v1',
  'starter_plan_v1',
  'pro_plan_v1',
  'power_plan_v1',
  'studio_plan_v1',
];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { features } = body;

  if (!Array.isArray(features) || features.some((f: unknown) => typeof f !== 'string' || !VALID_FEATURES.includes(f as FeatureNameKey))) {
    return NextResponse.json({ error: `features must be an array of: ${VALID_FEATURES.join(', ')}` }, { status: 400 });
  }

  const desired = new Set(features as FeatureNameKey[]);
  const current = new Set(await userFeatureModel.listUserFeatures(id));

  await Promise.all([
    ...[...desired].filter(f => !current.has(f)).map(f => userFeatureModel.addUserFeature(id, f, 'admin-update')),
    ...[...current].filter(f => !desired.has(f)).map(f => userFeatureModel.removeUserFeature(id, f)),
  ]);

  return NextResponse.json({ success: true, features: [...desired] });
}
