/**
 * POST /api/server/config/validate
 * Validate app configuration updates before applying.
 * Ported 1:1 from ConfigResolver.validateAppConfig.
 *
 * Body: { updates: Array<{ key: string; value: any }> }
 * Requires admin authentication.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';

export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  const body = await req.json();
  const { updates } = body;

  if (!Array.isArray(updates)) {
    return NextResponse.json({ error: 'updates must be an array' }, { status: 400 });
  }

  const errors: Array<{ key: string; message: string }> = [];

  for (const { key, value } of updates) {
    if (key === 'server.name' && typeof value === 'string' && value.length > 100) {
      errors.push({ key, message: 'Server name must be less than 100 characters' });
    }
  }

  return NextResponse.json(errors);
}
