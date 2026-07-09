import { generateText } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';

function stripCodeFence(raw: string): string {
  let stripped = raw.trim();
  if (stripped.startsWith('```')) {
    const firstNewline = stripped.indexOf('\n');
    if (firstNewline !== -1) stripped = stripped.slice(firstNewline + 1);
    if (stripped.endsWith('```')) stripped = stripped.slice(0, -3);
  }
  return stripped;
}

export const codeArtifact = {
  description:
    'Generate a single-file HTML snippet (with inline <style> and <script>) that accomplishes the ' +
    'requested functionality. The final HTML should be runnable when saved as an .html file and ' +
    'opened in a browser. Do NOT reference external resources (CSS, JS, images) except through data URIs.',
  inputSchema: z.object({
    title: z.string().describe('The title of the HTML page'),
    userPrompt: z.string().describe('The user description of the code artifact, will be used to generate the code artifact'),
  }),
  async execute({ title, userPrompt }: { title: string; userPrompt: string }) {
    const { text } = await generateText({
      model: await model(),
      messages: [
        {
          role: 'system',
          content:
            'Generate a single-file HTML snippet (inline <style> and <script>, no external resources ' +
            'except data URIs) that fulfills the request. Respond with ONLY the HTML, no explanation.',
        },
        { role: 'user', content: userPrompt },
      ],
    });

    const html = stripCodeFence(text);
    return { title, html, size: html.length };
  },
};
