/**
 * Replaces packages/ai/src/tools/python-coding.ts / the original
 * providers/tools/python-coding.ts (python_coding). No vendor lock-in.
 * Distinct from eve's built-in `bash` (which can already run
 * `python3 script.py` in the sandbox): this tool only *drafts* Python code
 * + a brief explanation as a structured product-UI result, it doesn't
 * execute anything — same "authored, product-specific rendering
 * contract" category as doc_compose/code_artifact/make_it_real, not
 * something the harness already covers.
 */
import { generateObject } from 'ai';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { model } from '../lib/gateway.js';

const PythonCodingResultSchema = z.object({
  code: z.string().describe('The generated Python code'),
  explanation: z.string().optional().describe('Brief explanation of the approach'),
});

export default defineTool({
  description: 'Generate Python code that satisfies a natural-language requirements description.',
  inputSchema: z.object({
    requirements: z.string().describe('The requirements to generate python code for'),
  }),
  outputSchema: PythonCodingResultSchema,
  async execute({ requirements }) {
    const { object } = await generateObject({
      model: await model(),
      schema: PythonCodingResultSchema,
      messages: [
        { role: 'system', content: 'Write complete, runnable Python code that satisfies the given requirements.' },
        { role: 'user', content: requirements },
      ],
    });
    return object;
  },
});
