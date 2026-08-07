import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import skillsCatalog from '../generated/skills-catalog.json' with { type: 'json' };

/** Fetches the full instructions for one skill by name -- checks the
 *  user's own self-authored skills first (via create_skill), then falls
 *  back to Entry's built-in skill library (see list_skills.ts's header
 *  for where that catalog comes from). A saved skill with the same slug
 *  as a built-in one intentionally wins -- that's the same "no, actually
 *  do it THIS way" override behavior create_skill's upsert already gives
 *  for two user-authored versions, just extended to also let a user
 *  override a built-in default. */
export const recallSkillTool = {
  description:
    'Get the full instructions for one skill by name -- either one of your self-authored skills or ' +
    'one of the built-in skills (see list_skills for the full list of both).',
  inputSchema: z.object({
    name: z.string().describe('The skill name/slug, as returned by list_skills'),
  }),
  async execute({ name }: { name: string }, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const row = await prisma.agentSkill.findUnique({ where: { userId_name: { userId, name: slug } } });
    if (row) return { source: 'your_saved_skills', name: row.name, description: row.description, instructions: row.instructions };

    const builtIn = skillsCatalog.skills.find(s => s.slug === slug);
    if (builtIn) {
      return {
        source: 'built_in_skills',
        name: builtIn.slug,
        description: builtIn.description,
        instructions: builtIn.instructions,
        // Some built-in skills reference companion scripts/references
        // files by relative path in their markdown (e.g. "see
        // references/doctrine.md") that aren't inlined here -- flag it
        // so the agent knows to look under the skill's own repo path
        // rather than assume a referenced path is missing/broken.
        has_additional_files: builtIn.hasResources,
        additional_files_path: builtIn.hasResources ? `apps/agent/agent/skills/${builtIn.slug}/` : undefined,
      };
    }

    return { error: `No skill named "${slug}" among your saved skills or the built-in library. Call list_skills to see what's available.` };
  },
};

recallSkillTool.execute = safeExecute('recall_skill', recallSkillTool.execute) as typeof recallSkillTool.execute;
Object.assign(recallSkillTool, withAgentTimeout('recall_skill', recallSkillTool));
