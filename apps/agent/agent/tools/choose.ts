/**
 * Replaces packages/ai/src/tools/choose.ts / the original providers/tools/choose.ts.
 * Zero model dependency — a pure pass-through schema the channel/frontend
 * renders as a picker. Nothing to migrate, nothing eve's harness already
 * covers either (this isn't a generic capability, it's this product's own
 * UI affordance) — a genuinely new authored tool either way.
 */
import { defineTool } from 'eve/tools';
import { z } from 'zod';

export default defineTool({
  description:
    'Present multiple options to the user for selection. The user can either choose from the ' +
    'provided options or provide their own input. Write option text in the language the user is using.',
  inputSchema: z.object({
    question: z.string().describe('The question or prompt to ask the user'),
    options: z
      .array(z.string())
      .min(2, 'At least 2 options are required')
      .describe('Options for the user to choose from'),
    multiSelect: z.boolean().optional().default(false),
  }),
  async execute({ question, options, multiSelect }) {
    return { question, options, multiSelect };
  },
});
