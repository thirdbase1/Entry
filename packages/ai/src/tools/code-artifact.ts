/**
 * Replaces providers/tools/code-artifact.ts (code_artifact) — same mechanical
 * port as doc-compose/task-analysis: went through `factory.getProviderByModel(...).text()`
 * in the original, i.e. no hardcoded vendor. No OCI-style lock-in to work around.
 */
import { z } from 'zod';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

export const createCodeArtifactTool = () => {
  return createTool(
    { toolName: 'code_artifact' },
    {
      description:
        'Generate a single-file HTML snippet (with inline <style> and <script>) that accomplishes the requested functionality. The final HTML should be runnable when saved as an .html file and opened in a browser. Do NOT reference external resources (CSS, JS, images) except through data URIs.',
      inputSchema: z.object({
        title: z.string().describe('The title of the HTML page'),
        userPrompt: z.string().describe('The user description of the code artifact, will be used to generate the code artifact'),
      }),
      execute: async ({ title, userPrompt }: { title: string; userPrompt: string }) => {
        try {
          const content = await copilotProvider.text(
            { outputType: ModelOutputType.Text },
            [
              {
                role: 'system',
                content:
                  'Generate a single-file HTML snippet (inline <style> and <script>, no external resources except data URIs) that fulfills the request. Respond with ONLY the HTML, no explanation.',
              },
              { role: 'user', content: userPrompt },
            ]
          );

          let stripped = content.trim();
          if (stripped.startsWith('```')) {
            const firstNewline = stripped.indexOf('\n');
            if (firstNewline !== -1) stripped = stripped.slice(firstNewline + 1);
            if (stripped.endsWith('```')) stripped = stripped.slice(0, -3);
          }

          return { title, html: stripped, size: stripped.length };
        } catch (err: any) {
          return toolError('Code Artifact Failed', err.message ?? String(err));
        }
      },
    }
  );
};
