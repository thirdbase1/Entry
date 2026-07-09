/**
 * Replaces providers/tools/python-coding.ts (python_coding) — mechanical
 * port, went through `factory.getProviderByModel(...).streamObject()` in the
 * original. No vendor lock-in. Note: this is distinct from python_sandbox
 * (vercel-sandbox.ts) — this tool only *writes* Python code from a
 * requirements description; it doesn't execute it.
 */
import { z } from 'zod';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

const PythonCodingResultSchema = z.object({
  code: z.string().describe('The generated Python code'),
  explanation: z.string().optional().describe('Brief explanation of the approach'),
});

export const createPythonCodingTool = () => {
  return createTool(
    { toolName: 'python_coding' },
    {
      description: 'This tool(python-coding) is used to generate python code',
      inputSchema: z.object({
        requirements: z.string().describe('The requirements to generate python code'),
      }),
      execute: async ({ requirements }: { requirements: string }) => {
        try {
          const result = await copilotProvider.structured(
            { outputType: ModelOutputType.Structured },
            [
              { role: 'system', content: 'Write complete, runnable Python code that satisfies the given requirements.' },
              { role: 'user', content: requirements },
            ],
            PythonCodingResultSchema
          );
          return result;
        } catch (err: any) {
          return toolError('Python Coding Tool Failed', err.message ?? String(err));
        }
      },
    }
  );
};
