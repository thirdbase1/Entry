import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { z } from 'zod';

const AddModelSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().optional(),
});

/**
 * POST /api/user/byok/providers/:providerId/models
 * Manually add a single model by id — the fallback when a provider
 * doesn't support (or the user doesn't want to use) the fetch-models
 * discovery call.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const provider = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = AddModelSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const model = await prisma.userModelProviderModel.upsert({
    where: { providerId_modelId: { providerId, modelId: body.data.modelId } },
    create: { providerId, modelId: body.data.modelId, label: body.data.label },
    update: { label: body.data.label },
  });

  return NextResponse.json({ id: model.id, modelId: model.modelId, label: model.label, isEnabled: model.isEnabled });
}
