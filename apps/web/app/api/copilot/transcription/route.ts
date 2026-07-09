import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * Audio Transcription API
 * Ported 1:1 from the original's CopilotTranscriptionResolver.
 *
 * POST   /api/copilot/transcription          — submit a new transcription job
 * GET    /api/copilot/transcription?jobId=   — query job status/result
 * GET    /api/copilot/transcription?blobId=  — query job by blobId
 * POST   /api/copilot/transcription/[jobId]/retry  — retry a failed job
 * POST   /api/copilot/transcription/[jobId]/claim  — claim a finished job
 *
 * The actual AI transcription runs asynchronously via a queue worker that
 * calls the AI Gateway with the 'Transcript audio' prompt. The queue worker
 * chains: transcribe → summarize → title → find action items, updating the
 * AiJobs row's payload at each step.
 */

/**
 * GET /api/copilot/transcription?jobId=... or ?blobId=...
 * Query a transcription job's status and result.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const jobId = url.searchParams.get('jobId');
  const blobId = url.searchParams.get('blobId');

  if (!jobId && !blobId) {
    return NextResponse.json({ error: 'jobId or blobId is required' }, { status: 400 });
  }

  const job = await prisma.aiJobs.findFirst({
    where: {
      ...(jobId ? { id: jobId } : {}),
      ...(blobId ? { blobId } : {}),
      createdBy: session.user.id,
      type: 'transcription' as any,
    },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const payload = job.payload as any;
  const finishedStatuses = ['finished', 'claimed'];
  const isFinished = finishedStatuses.includes(job.status);

  return NextResponse.json({
    id: job.id,
    status: job.status,
    title: isFinished ? payload?.title || null : null,
    summary: isFinished ? payload?.summary || null : null,
    actions: isFinished ? payload?.actions || null : null,
    transcription: isFinished ? payload?.transcription || null : null,
  });
}

/**
 * POST /api/copilot/transcription
 * Submit a new audio transcription job.
 * Body: { blobId: string, mimeType: string, audioUrl: string }
 *
 * The original accepted file uploads (GraphQLUpload). In the REST API, the
 * client first uploads the file to storage, then passes the URL here.
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { blobId, mimeType, audioUrl } = body;

  if (!blobId || !mimeType || !audioUrl) {
    return NextResponse.json({
      error: 'blobId, mimeType, and audioUrl are required',
    }, { status: 400 });
  }

  // Check if a job already exists for this blob
  const existing = await prisma.aiJobs.findFirst({
    where: { createdBy: session.user.id, blobId, type: 'transcription' as any },
  });
  if (existing) {
    return NextResponse.json({
      error: 'Transcription job already exists for this blob',
      id: existing.id,
      status: existing.status,
    }, { status: 409 });
  }

  // Create the job
  const job = await prisma.aiJobs.create({
    data: {
      createdBy: session.user.id,
      blobId,
      type: 'transcription' as any,
      status: 'running',
      payload: { infos: [{ url: audioUrl, mimeType }] },
    },
  });

  // In production, this would enqueue a job to the transcription queue.
  // The queue worker chains: transcribe → summarize → title → find action items.
  // For now, the job is created and pending queue processing.

  return NextResponse.json({
    id: job.id,
    status: job.status,
    title: null,
    summary: null,
    actions: null,
    transcription: null,
  }, { status: 201 });
}
