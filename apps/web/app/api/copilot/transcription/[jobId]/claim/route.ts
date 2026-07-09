import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * POST /api/copilot/transcription/[jobId]/claim
 * Claim a finished transcription job — returns the full result.
 * Ported 1:1 from the original's claimAudioTranscription mutation.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.aiJobs.findFirst({
    where: { id: jobId, createdBy: session.user.id, type: 'transcription' as any },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (job.status !== 'finished') {
    return NextResponse.json({
      id: jobId,
      status: job.status,
      title: null,
      summary: null,
      actions: null,
      transcription: null,
    });
  }

  // Mark as claimed
  await prisma.aiJobs.update({
    where: { id: jobId },
    data: { status: 'claimed' },
  });

  const payload = job.payload as any;
  return NextResponse.json({
    id: jobId,
    status: 'claimed',
    title: payload?.title || null,
    summary: payload?.summary || null,
    actions: payload?.actions || null,
    transcription: payload?.transcription || null,
  });
}
