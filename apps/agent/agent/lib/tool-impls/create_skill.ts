import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/**
 * "Let the model create new skills by itself." Deliberately NOT arbitrary
 * stored/executed code — a skill saved here is the exact same shape as
 * the static SKILL.md files under apps/agent/agent/skills/ (a
 * description of when to use it + markdown instructions), so it can only
 * ever teach the agent new STEPS for tools it already safely has (bash in
 * its own already-isolated per-chat sandbox, browser_use, etc.) — never a
 * new capability, so there's no code-injection surface despite being
 * fully agent-writable. Scoped per-user (@@unique([userId, name])) —
 * saving under a name that already exists for this user overwrites it
 * (upsert), which is the expected "no, actually do it THIS way" correction
 * flow.
 */
export const createSkillTool = {
  description:
    'Save a new reusable skill for yourself — a named, reusable set of instructions for a workflow ' +
    "you've figured out (e.g. exactly how this user likes their app deployed, or the steps for some " +
    'API only they use). Next time something similar comes up (in this chat or a future one), call ' +
    'list_skills or recall_skill to remember it instead of re-figuring it out. Saving under a name ' +
    'that already exists overwrites the old version.',
  inputSchema: z.object({
    name: z.string().describe('A short slug for this skill, e.g. "deploy-my-fastapi-app"'),
    description: z.string().describe('When you should reach for this skill — as specific as possible'),
    instructions: z.string().describe('The actual step-by-step instructions, in markdown'),
  }),
  async execute(
    { name, description, instructions }: { name: string; description: string; instructions: string },
    ctx: ToolExecCtx
  ) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return { error: 'name must contain at least one letter or digit.' };
    await prisma.agentSkill.upsert({
      where: { userId_name: { userId, name: slug } },
      create: { userId, name: slug, description, instructions },
      update: { description, instructions },
    });
    return { ok: true, name: slug };
  },
};

createSkillTool.execute = safeExecute('create_skill', createSkillTool.execute) as typeof createSkillTool.execute;
