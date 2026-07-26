import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/** One-off diag: every distinct (model, provider) pair ever logged, across
 *  ALL users -- used to make sure ModelPriceRate seeding covers every
 *  model actually in use, not just whichever ones show up in one user's
 *  own Usage tab. */
export async function GET(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await prisma.usageEvent.groupBy({
    by: ['model', 'provider'],
    _count: { _all: true },
    orderBy: { _count: { model: 'desc' } },
  });
  return NextResponse.json({ ok: true, count: rows.length, rows });
}
