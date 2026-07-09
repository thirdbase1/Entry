/**
 * Replaces providers/tools/doc-compose.ts (doc_compose). The original went
 * through `factory.getProviderByModel(...).streamObject(...)`, i.e. whichever
 * model a DB-configured prompt selected — now routed through `copilotProvider`.
 *
 * Doc persistence is now wired: the composed markdown is saved via
 * `addDoc()` from `@entry/copilot` (Prisma + embedding job enqueue), and the
 * real `docId` is returned to the caller — matching the original's contract.
 */
import { z } from 'zod';

import { addDoc } from '@entry/copilot';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

export const createDocComposeTool = (opts?: { userId?: string; sessionId?: string }) => {
  return createTool(
    { toolName: 'doc_compose' },
    {
      description:
        'Write a new document with markdown content. This tool creates structured markdown content for documents including titles, sections, and formatting.',
      inputSchema: z.object({
        title: z.string().describe('The title of the document'),
        userPrompt: z.string().describe('The user description of the document, will be used to generate the document'),
      }),
      execute: async ({ title, userPrompt }: { title: string; userPrompt: string }) => {
        try {
          const content = await copilotProvider.text(
            { outputType: ModelOutputType.Text },
            [
              {
                role: 'system',
                content:
                  'Write a complete, well-structured markdown document (title, sections, formatting) based on the user\'s description.',
              },
              { role: 'user', content: userPrompt },
            ]
          );

          let docId: string | undefined;
          if (opts?.userId && opts?.sessionId) {
            const doc = await addDoc(opts.userId, opts.sessionId, { title, content });
            docId = doc.docId;
          }

          return {
            docId,
            title,
            markdown: content,
            wordCount: content.split(/\s+/).length,
          };
        } catch (err: any) {
          return toolError('Doc Write Failed', err.message);
        }
      },
    }
  );
};
