import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/** One-off diag: every ModelPriceRate row, to debug matching/duplicate
 *  issues (owner report 2026-07-26: claude-opus-4-6 showing $32.07 for
 *  ~1.6M tokens, way above any plausible real rate). */
export async function GET(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await prisma.modelPriceRate.findMany({ orderBy: [{ modelPattern: 'asc' }, { effectiveFrom: 'desc' }] });
  return NextResponse.json({ ok: true, count: rows.length, rows });
}
