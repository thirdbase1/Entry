import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

const PythonCodingResultSchema = z.object({
  code: z.string().describe('The generated Python code'),
  explanation: z.string().optional().describe('Brief explanation of the approach'),
});

export const pythonCoding = {
  description: 'Generate Python code that satisfies a natural-language requirements description.',
  inputSchema: z.object({
    requirements: z.string().describe('The requirements to generate python code for'),
  }),
  outputSchema: PythonCodingResultSchema,
  async execute({ requirements }: { requirements: string }, ctx?: ToolExecCtx) {
    const { object } = await generateObject({
      model: await model(undefined, ctx?.byokModel),
      schema: PythonCodingResultSchema,
      // See task_analysis.ts's comment -- top-level `system`, not an
      // embedded `role: 'system'` message, is what actually survives
      // translation into Responses-API-style providers.
      system: 'Write complete, runnable Python code that satisfies the given requirements.',
      messages: [{ role: 'user', content: requirements }],
    });
    return object;
  },
};

pythonCoding.execute = safeExecute('python_coding', pythonCoding.execute) as typeof pythonCoding.execute;
