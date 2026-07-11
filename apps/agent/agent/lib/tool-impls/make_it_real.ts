import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import { addDoc } from '@entry/copilot';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

const MakeItRealResultSchema = z.object({
  content: z.string().describe('The improved markdown content with a more beautiful layout/slideshow structure'),
});

export const makeItReal = {
  description: 'This tool (make-it-real) is used to improve the document with more beautiful layout or slide show.',
  inputSchema: z.object({
    instructions: z.string().optional().describe("User's special requirements."),
    markdown: z.string().describe('The markdown content'),
  }),
  outputSchema: MakeItRealResultSchema,
  async execute({ instructions, markdown }: { instructions?: string; markdown: string }, ctx: ToolExecCtx) {
    const { object } = await generateObject({
      model: await model(undefined, ctx.byokModel),
      schema: MakeItRealResultSchema,
      // See task_analysis.ts's comment.
      system:
        'Improve the given markdown document with a more beautiful, presentation-ready layout ' +
        '(e.g. slide-like sectioning, better headings/formatting) per any special instructions. ' +
        'Return the full improved markdown.',
      messages: [
        {
          role: 'user',
          content: `Instructions: ${instructions ?? 'No instructions'}\n\nContent:\n${markdown}`,
        },
      ],
    });

    const userId = ctx.session.auth.current?.principalId ?? 'unknown';
    const sessionId = ctx.session.id;
    const doc = await addDoc(userId, sessionId, {
      title: 'Improved Document',
      content: object.content,
    });

    return { content: object.content, docId: doc.docId };
  },
};

makeItReal.execute = safeExecute('make_it_real', makeItReal.execute) as typeof makeItReal.execute;
