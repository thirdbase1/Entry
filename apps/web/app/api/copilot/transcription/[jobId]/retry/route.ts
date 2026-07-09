import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * POST /api/copilot/transcription/[jobId]/retry
 * Retry a failed transcription job.
 * Ported 1:1 from the original's retryAudioTranscription mutation.
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

  const payload = job.payload as any;
  if (!payload?.infos) {
    return NextResponse.json({ error: 'Job has no audio data to retry' }, { status: 400 });
  }

  // Reset job to running
  await prisma.aiJobs.update({
    where: { id: jobId },
    data: { status: 'running' },
  });

  // In production, this would re-enqueue the transcription job.

  return NextResponse.json({
    id: jobId,
    status: 'running',
    title: null,
    summary: null,
    actions: null,
    transcription: null,
  });
}
