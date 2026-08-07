import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import skillsCatalog from '../generated/skills-catalog.json' with { type: 'json' };

/** Lists both this user's self-authored skills (via create_skill) AND the
 *  built-in skill library shipped with Entry itself (2026-08-07 --
 *  apps/agent/agent/skills/*\/SKILL.md, compiled at build time into
 *  skills-catalog.json by apps/agent/scripts/build-skills-catalog.mjs --
 *  see that script's header for why a generated JSON import instead of a
 *  runtime fs.readdir, which would silently find nothing once deployed).
 *  Call recall_skill to get the full instructions for either kind. */
export const listSkillsTool = {
  description:
    'List every skill available to you right now: both the built-in skill library that ships with ' +
    'Entry (deployment workflows, browser automation, framework best-practices, writing guidelines, ' +
    "etc.) and any skills you've previously saved for yourself for this user via create_skill. Each " +
    'entry has a name + short description of when it applies. Call this when starting a task that ' +
    "might match something built-in or something you've already figured out before, and call " +
    'recall_skill on a matching name before improvising from scratch.',
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const rows = await prisma.agentSkill.findMany({
      where: { userId },
      select: { name: true, description: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const builtIn = skillsCatalog.skills.map(s => ({ name: s.slug, description: s.description }));
    return {
      built_in_skills: builtIn,
      your_saved_skills: rows,
    };
  },
};

listSkillsTool.execute = safeExecute('list_skills', listSkillsTool.execute) as typeof listSkillsTool.execute;
Object.assign(listSkillsTool, withAgentTimeout('list_skills', listSkillsTool));
