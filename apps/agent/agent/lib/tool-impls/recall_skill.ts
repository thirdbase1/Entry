import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/** Fetches the full instructions for one previously self-authored skill
 *  by name (from list_skills). */
export const recallSkillTool = {
  description: 'Get the full saved instructions for one of your self-authored skills, by name (see list_skills).',
  inputSchema: z.object({
    name: z.string().describe('The skill name/slug, as returned by list_skills'),
  }),
  async execute({ name }: { name: string }, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const row = await prisma.agentSkill.findUnique({ where: { userId_name: { userId, name: slug } } });
    if (!row) return { error: `No saved skill named "${slug}". Call list_skills to see what's available.` };
    return { name: row.name, description: row.description, instructions: row.instructions };
  },
};

recallSkillTool.execute = safeExecute('recall_skill', recallSkillTool.execute) as typeof recallSkillTool.execute;
