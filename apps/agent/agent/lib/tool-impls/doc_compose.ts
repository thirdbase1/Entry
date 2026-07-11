import { generateText } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import { addDoc } from '@entry/copilot';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

export const docCompose = {
  description:
    'Write a new document with markdown content. This tool creates structured markdown content ' +
    'for documents including titles, sections, and formatting.',
  inputSchema: z.object({
    title: z.string().describe('The title of the document'),
    userPrompt: z.string().describe('The user description of the document, will be used to generate the document'),
  }),
  async execute({ title, userPrompt }: { title: string; userPrompt: string }, ctx: ToolExecCtx) {
    const { text } = await generateText({
      model: await model(undefined, ctx.byokModel),
      // See task_analysis.ts's comment.
      system:
        "Write a complete, well-structured markdown document (title, sections, formatting) based on the user's description.",
      messages: [{ role: 'user', content: userPrompt }],
    });

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
};

docCompose.execute = safeExecute('doc_compose', docCompose.execute) as typeof docCompose.execute;
