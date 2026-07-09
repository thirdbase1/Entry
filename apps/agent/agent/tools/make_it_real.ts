/**
 * Replaces packages/ai/src/tools/make-it-real.ts / the original
 * providers/tools/make-it-real.ts (make_it_real). No vendor lock-in —
 * mechanical port onto `generateObject` against the shared Gateway
 * `model()` helper. Now persists the improved doc via `addDoc()` from
 * `@entry/copilot` (was a TODO stub — now returns a real docId and
 * enqueues the embedding job, matching the original's `saveDoc()` contract).
 */
import { generateObject } from 'ai';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { model } from '../lib/gateway.js';
import { addDoc } from '@entry/copilot';

const MakeItRealResultSchema = z.object({
  content: z.string().describe('The improved markdown content with a more beautiful layout/slideshow structure'),
});

export default defineTool({
  description: 'This tool (make-it-real) is used to improve the document with more beautiful layout or slide show.',
  inputSchema: z.object({
    instructions: z.string().optional().describe("User's special requirements."),
    markdown: z.string().describe('The markdown content'),
  }),
  outputSchema: MakeItRealResultSchema,
  async execute({ instructions, markdown }, ctx) {
    const { object } = await generateObject({
      model: await model(),
      schema: MakeItRealResultSchema,
      messages: [
        {
          role: 'system',
          content:
            'Improve the given markdown document with a more beautiful, presentation-ready layout ' +
            '(e.g. slide-like sectioning, better headings/formatting) per any special instructions. ' +
            'Return the full improved markdown.',
        },
        {
          role: 'user',
          content: `Instructions: ${instructions ?? 'No instructions'}\n\nContent:\n${markdown}`,
        },
      ],
    });

    // Persist the improved doc to DB
    const userId = ctx.session.auth.current?.principalId ?? 'unknown';
    const sessionId = ctx.session.id;
    const doc = await addDoc(userId, sessionId, {
      title: 'Improved Document',
      content: object.content,
    });

    return { content: object.content, docId: doc.docId };
  },
});
