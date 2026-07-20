import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

/** Lists this user's self-authored skills (name + description only —
 *  call recall_skill to get the full instructions for one). */
export const listSkillsTool = {
  description:
    'List the skills you have previously saved for yourself for this user (via create_skill) — ' +
    'name + short description of when each applies. Call this when starting a task that might ' +
    "match something you've already figured out before.",
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const rows = await prisma.agentSkill.findMany({
      where: { userId },
      select: { name: true, description: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    return { skills: rows };
  },
};

listSkillsTool.execute = safeExecute('list_skills', listSkillsTool.execute) as typeof listSkillsTool.execute;
Object.assign(listSkillsTool, withAgentTimeout('list_skills', listSkillsTool));
