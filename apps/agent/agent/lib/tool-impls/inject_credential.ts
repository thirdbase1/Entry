import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { getCredential } from '../credential-vault.js';

/**
 * The "inject auth" half of the vault. Decrypts a saved credential
 * SERVER-SIDE and writes it directly into the sandbox's persistent
 * ~/.entry_env file (idempotent — replaces any prior value for the same
 * envVarName) as `export NAME='value'` — the decrypted value is embedded
 * only in a command THIS tool-impl builds itself, never in anything the
 * model wrote or sees; the tool's own return value never contains it.
 *
 * @vercel/sandbox has no API to add env vars to an ALREADY-RUNNING
 * sandbox (its `env` option only applies at creation time — checked
 * directly against node_modules/@vercel/sandbox/dist/sandbox.d.ts), and a
 * chat's sandbox is typically already alive by the time a credential is
 * saved. A persistent dotfile sourced on demand is the practical
 * workaround: the direct-chat path's own `bash` tool-impl auto-sources it
 * on every call (see bash.ts), so it's fully transparent there; eve's
 * native default-path bash tool can't be modified from here (it lives
 * inside the `eve` package), so for that path the model is told to
 * explicitly `source ~/.entry_env` first — see this tool's own result
 * and the credential-vault skill doc for the exact one-liner.
 */
export const injectCredentialTool = {
  description:
    "Make a previously-saved credential available inside the sandbox as an environment variable, " +
    "without ever exposing its value to you. Use this right before a sandbox command that needs auth " +
    "(git push, a deploy CLI, curl with an Authorization header, etc.) instead of asking the user to " +
    "paste the secret into a shell command directly.",
  inputSchema: z.object({
    service: z.string().describe('Which saved credential to use, e.g. "github", "vercel"'),
    label: z.string().optional().describe('Only needed if more than one credential is saved for this service. Defaults to "default".'),
    envVarName: z.string().describe('The environment variable name to expose it as inside the sandbox, e.g. "GITHUB_TOKEN"'),
  }),
  async execute(
    { service, label, envVarName }: { service: string; label?: string; envVarName: string },
    ctx: ToolExecCtx
  ) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVarName)) {
      return { error: 'envVarName must be a valid shell variable name (letters, digits, underscore; not starting with a digit).' };
    }
    const value = await getCredential(userId, service, label);
    if (value == null) {
      return {
        error: `No saved credential for service "${service}"${label && label !== 'default' ? ` / label "${label}"` : ''}. ` +
          'Ask the user for it, then call save_credential first.',
      };
    }
    const sandbox = await ctx.getSandbox();
    const escaped = value.replace(/'/g, `'\\''`);
    await sandbox.run({
      command:
        `touch ~/.entry_env; ` +
        `grep -v "^export ${envVarName}=" ~/.entry_env > ~/.entry_env.tmp 2>/dev/null; ` +
        `mv ~/.entry_env.tmp ~/.entry_env 2>/dev/null; ` +
        `echo "export ${envVarName}='${escaped}'" >> ~/.entry_env`,
    });
    return {
      ok: true,
      envVarName,
      howToUse:
        `$${envVarName} is now set in ~/.entry_env for this sandbox. Prefix commands that need it with ` +
        `"source ~/.entry_env; " — e.g. source ~/.entry_env; git push https://$${envVarName}@github.com/user/repo.git. ` +
        'The value itself was never shown to you and never will be.',
    };
  },
};

injectCredentialTool.execute = safeExecute('inject_credential', injectCredentialTool.execute) as typeof injectCredentialTool.execute;
