import { z } from 'zod';

export const choose = {
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
  async execute({ question, options, multiSelect }: { question: string; options: string[]; multiSelect?: boolean }) {
    return { question, options, multiSelect };
  },
};
