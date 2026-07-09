/**
 * Replaces providers/tools/make-it-real.ts (make_it_real). Mechanical port
 * through `copilotProvider.structured()` — no vendor lock-in.
 *
 * Doc persistence is now wired: the enhanced markdown is saved via `addDoc()`
 * from `@entry/copilot` and a real `docId` is returned, matching the original's
 * `saveDoc()` contract.
 */
import { z } from 'zod';

import { addDoc } from '@entry/copilot';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

const MakeItRealResultSchema = z.object({
  content: z.string().describe('The improved markdown content with a more beautiful layout/slideshow structure'),
});

export const createMakeItRealTool = (opts?: { userId?: string; sessionId?: string }) => {
  return createTool(
    { toolName: 'make_it_real' },
    {
      description: 'This tool(make-it-real) is used to improve the document with more beautiful layout or slide show.',
      inputSchema: z.object({
        instructions: z.string().optional().describe("User's special requirements."),
        markdown: z.string().describe('The markdown content'),
      }),
      execute: async ({ instructions, markdown }: { instructions?: string; markdown: string }) => {
        try {
          const result = await copilotProvider.structured(
            { outputType: ModelOutputType.Structured },
            [
              {
                role: 'system',
                content:
                  'Improve the given markdown document with a more beautiful, presentation-ready layout (e.g. slide-like sectioning, ' +
                  'better headings/formatting) per any special instructions. Return the full improved markdown.',
              },
              {
                role: 'user',
                content: `Instructions: ${instructions ?? 'No instructions'}\n\nContent:\n${markdown}`,
              },
            ],
            MakeItRealResultSchema
          );

          let docId: string | undefined;
          if (opts?.userId && opts?.sessionId) {
            const doc = await addDoc(opts.userId, opts.sessionId, {
              title: 'Make It Real',
              content: result.content,
            });
            docId = doc.docId;
          }

          return { docId, content: result.content };
        } catch (err: any) {
          return toolError('Make It Real Layout Enhancer Failed', err.message ?? String(err));
        }
      },
    }
  );
};
