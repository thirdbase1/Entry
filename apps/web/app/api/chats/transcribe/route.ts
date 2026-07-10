import { NextRequest, NextResponse } from 'next/server';
import { transcribe } from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { gateway } from '@ai-sdk/gateway';

/**
 * POST /api/chats/transcribe
 * Powers the mic button in the chat prompt input (components/chat/chat-input.tsx).
 * Accepts a recorded audio clip (multipart form field "audio"), transcribes it
 * via the same Vercel AI Gateway credential already used for chat/model routing
 * (no separate STT provider key needed), and returns the plain text so it can be
 * dropped straight into the prompt textarea.
 *
 * Kept deliberately separate from the existing /api/copilot/transcription
 * pipeline — that one is an async queue-backed job (submit -> poll -> claim)
 * built for long meeting recordings and summarization side-effects. This is a
 * short voice-to-text utterance that needs to resolve synchronously in a
 * couple of seconds so it can go straight back into the same request/response
 * cycle the mic button is waiting on.
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get('audio') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No audio provided' }, { status: 400 });
  }

  const MAX_BYTES = 15 * 1024 * 1024; // 15MB — generous for a short voice note, well under function body limits
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Audio too large' }, { status: 413 });
  }
  if (file.size === 0) {
    return NextResponse.json({ text: '' });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await transcribe({
      model: gateway.transcriptionModel('openai/whisper-1'),
      audio: buffer,
    });
    return NextResponse.json({ text: result.text ?? '' });
  } catch (err) {
    console.error('[transcribe] failed', err);
    return NextResponse.json({ error: 'Transcription failed, please try again' }, { status: 502 });
  }
}
