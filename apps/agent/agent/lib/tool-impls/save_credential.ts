import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { saveCredential } from '../credential-vault.js';

/**
 * "A secure place in the sandbox where the AI can save credentials" —
 * this is that place. The raw value passed in here DOES pass through the
 * model's own tool-CALL (input), which is unavoidable — the user has to
 * tell the agent the secret somehow, in-chat. What this tool guarantees
 * is everything AFTER that: the value is encrypted before it ever
 * touches the DB (see credential-vault.ts) and this tool's own RESULT
 * never echoes it back, so it doesn't linger in the model's context for
 * the rest of the conversation or get repeated back to the user.
 */
export const saveCredentialTool = {
  description:
    'Securely save a credential (API key, token, password) for later use, so the user never has ' +
    'to repeat it. Encrypted at rest; never shown back to you or the user again after this call. ' +
    'Use `service` for what it is (e.g. "github", "vercel", "stripe", "openai", or any other name ' +
    "the user gives you — it doesn't need to be a service we already know about). Call inject_credential " +
    'later to actually use a saved one (e.g. inside the sandbox for a git push or a deploy).',
  inputSchema: z.object({
    service: z.string().describe('Short machine key for what this credential is, e.g. "github", "vercel", "stripe"'),
    label: z.string().optional().describe('Only needed if saving MORE THAN ONE credential for the same service (e.g. two GitHub accounts). Defaults to "default".'),
    value: z.string().describe('The actual secret value to store (API key, token, password, etc.)'),
  }),
  async execute({ service, label, value }: { service: string; label?: string; value: string }, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session — cannot save a credential.' };
    await saveCredential({ userId, service, label, value });
    return {
      ok: true,
      service,
      label: label ?? 'default',
      note: 'Saved and encrypted. Never repeat this value back to the user — it is stored, not memorized in this conversation.',
    };
  },
};

saveCredentialTool.execute = safeExecute('save_credential', saveCredentialTool.execute) as typeof saveCredentialTool.execute;
Object.assign(saveCredentialTool, withAgentTimeout('save_credential', saveCredentialTool));
