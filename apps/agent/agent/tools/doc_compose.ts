/**
 * Replaces packages/ai/src/tools/doc-compose.ts / the original
 * providers/tools/doc-compose.ts (doc_compose). No vendor lock-in to work
 * around — same pattern as task_analysis.ts, ported onto the shared
 * Gateway `model()` helper.
 *
 * Two things intentionally NOT ported yet, flagged rather than faked:
 *   1. The original streamed incremental tokens to the chat UI via a
 *      `toolStream`/`duplicateStreamObjectStream` pipeline. eve's own
 *      tool-call streaming (session stream events) is the natural
 *      replacement once the frontend consumes `/eve/v1/session/:id/stream`
 *      — this version just awaits the full text for now.
 *   2. Streaming aside, the doc IS now persisted to the real DB via
 *      `addDoc()` from `@entry/copilot` (was a TODO stub returning
 *      `docId: undefined` — now returns a real docId and enqueues the
 *      embedding job, matching the original's `saveDoc()` contract).
 */
import { generateText } from 'ai';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { model } from '../lib/gateway.js';
import { addDoc } from '@entry/copilot';

export default defineTool({
  description:
    'Write a new document with markdown content. This tool creates structured markdown content ' +
    'for documents including titles, sections, and formatting.',
  inputSchema: z.object({
    title: z.string().describe('The title of the document'),
    userPrompt: z.string().describe('The user description of the document, will be used to generate the document'),
  }),
  async execute({ title, userPrompt }, ctx) {
    const { text } = await generateText({
      model: await model(),
      messages: [
        {
          role: 'system',
          content:
            "Write a complete, well-structured markdown document (title, sections, formatting) based on the user's description.",
        },
        { role: 'user', content: userPrompt },
      ],
    });

    // Persist to DB — userId from session auth, sessionId from eve session
    const userId = ctx.session.auth.current?.principalId ?? 'unknown';
    const sessionId = ctx.session.id;
    const doc = await addDoc(userId, sessionId, { title, content: text });

    return {
      docId: doc.docId,
      title,
      markdown: text,
      wordCount: text.split(/\s+/).length,
    };
  },
});
