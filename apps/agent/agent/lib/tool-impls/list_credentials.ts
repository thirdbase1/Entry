import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { listCredentials } from '../credential-vault.js';

/**
 * Metadata-only listing (service/label/last-updated — never the value).
 * Lets the agent check "do I already have a GitHub token saved for this
 * user?" before asking them to repeat it, without ever touching the
 * decrypted secret itself.
 */
export const listCredentialsTool = {
  description:
    'List which credentials are already saved for this user (service + label + when saved — never the ' +
    'actual value). Call this before asking the user for a token/key you might already have saved.',
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    const rows = await listCredentials(userId);
    return { credentials: rows.map(r => ({ service: r.service, label: r.label, updatedAt: r.updatedAt })) };
  },
};

listCredentialsTool.execute = safeExecute('list_credentials', listCredentialsTool.execute) as typeof listCredentialsTool.execute;
