/**
 * Replaces providers/tools/conversation-summary.ts (conversation_summary) —
 * same mechanical port, went through `factory.getProviderByModel(...).text()`
 * in the original. No vendor lock-in.
 */
import { z } from 'zod';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

export const createConversationSummaryTool = () => {
  return createTool(
    { toolName: 'conversation_summary' },
    {
      description:
        'Create a concise, AI-generated summary of the conversation so far—capturing key topics, decisions, and critical details. Use this tool whenever the context becomes lengthy to preserve essential information that might otherwise be lost to truncation in future turns.',
      inputSchema: z.object({
        focus: z.string().optional().describe('Optional focus area for the summary (e.g., "technical decisions", "user requirements", "project status")'),
        length: z
          .enum(['brief', 'detailed', 'comprehensive'])
          .default('detailed')
          .describe('The desired length of the summary: brief (1-2 sentences), detailed (paragraph), comprehensive (multiple paragraphs)'),
      }),
      execute: async (
        { focus, length }: { focus?: string; length: 'brief' | 'detailed' | 'comprehensive' },
        { messages }: { messages?: { role: string; content: unknown }[] }
      ) => {
        try {
          if (!messages || messages.length === 0) {
            return toolError('No Conversation Context', 'No messages available to summarize');
          }

          const summary = await copilotProvider.text(
            { outputType: ModelOutputType.Text },
            [
              {
                role: 'system',
                content: `Summarize the conversation so far. Focus: ${focus || 'general'}. Length: ${length}.`,
              },
              {
                role: 'user',
                content: messages.map(m => `${m.role}: ${String(m.content)}`).join('\n'),
              },
            ]
          );

          return {
            focusArea: focus || 'general',
            messageCount: messages.length,
            summary,
            timestamp: new Date().toISOString(),
          };
        } catch (err: any) {
          return toolError('Conversation Summary Failed', err.message);
        }
      },
    }
  );
};
