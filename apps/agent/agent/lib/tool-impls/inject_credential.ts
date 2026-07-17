import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { resolveServiceCredential } from '../connect-service-tokens.js';

/**
 * SECURITY FIX (2026-07-15): the previous version of this tool wrote the
 * decrypted secret into a persistent `~/.entry_env` file inside the
 * sandbox, exported as `export NAME='value'`, and told the model to
 * `source ~/.entry_env` before whatever command needed it. That looked
 * safe in isolation (the tool's own return value never contained the
 * secret) but was NOT safe in practice: the model has its own unrestricted
 * `bash` tool against the exact same sandbox, so its very next tool call
 * could simply run `echo $NAME` or `cat ~/.entry_env` and get the raw
 * value straight back into its own context — completely defeating the
 * point. A prompt telling the model "here's the env var name it's under"
 * is not a security boundary when the model can freely read that
 * environment itself one call later. Confirmed exploitable, reported by
 * the app owner.
 *
 * REAL FIX: this tool no longer "sets" anything durable. It now performs
 * the ONE authenticated command itself, in a single shot, passing the
 * decrypted secret as a process-scoped env var to @vercel/sandbox's
 * `runCommand` — which (unlike the sandbox-level `env` passed at
 * creation) only applies to that single spawned process, not to the
 * sandbox's persistent state, so it is never visible to any later,
 * separate `bash`/`runCommand` call the model makes (confirmed against
 * node_modules/@vercel/sandbox/dist/sandbox.d.ts — per-call `env` on
 * `runCommand` is documented as scoped to that fork only). Nothing is
 * ever written to disk. And as defense in depth, the raw value is
 * stripped out of stdout/stderr before the result is handed back to the
 * model, in case some CLI/API happens to echo it in an error message.
 *
 * The model still writes the command (e.g. `git push https://$TOKEN@
 * github.com/user/repo.git`) but never needs to know, hold, or be able
 * to re-read the actual secret value — it only ever sees the variable
 * name it chose, never the value, and there is no separate call it can
 * make afterward to recover it.
 */
export const injectCredentialTool = {
  description:
    'Run ONE shell command in the sandbox with a previously-saved credential available as an ' +
    'environment variable, without the value ever being written to disk, persisted for later commands, ' +
    'or shown to you. Use this instead of asking the user to paste a secret into a shell command, and ' +
    'instead of save_credential + a separate bash call. Reference the variable by the `envVarName` you ' +
    'choose inside `command` (e.g. envVarName "GITHUB_TOKEN", command \'git push https://$GITHUB_TOKEN@' +
    "github.com/user/repo.git'). This only affects this single command — it does NOT persist for any " +
    'later bash call, by design.',
  inputSchema: z.object({
    service: z.string().describe('Which saved credential to use, e.g. "github", "vercel"'),
    label: z.string().optional().describe('Only needed if more than one credential is saved for this service. Defaults to "default".'),
    envVarName: z.string().describe('The environment variable name to expose it as for this one command, e.g. "GITHUB_TOKEN"'),
    command: z.string().describe(
      'The single shell command to run with that env var set, e.g. \'git push https://$GITHUB_TOKEN@github.com/user/repo.git\'. ' +
      'Reference the credential only via $envVarName — never type the literal secret value.'
    ),
  }),
  async execute(
    { service, label, envVarName, command }: { service: string; label?: string; envVarName: string; command: string },
    ctx: ToolExecCtx
  ) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session.' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVarName)) {
      return { error: 'envVarName must be a valid shell variable name (letters, digits, underscore; not starting with a digit).' };
    }
    const resolved = await resolveServiceCredential(userId, service, label);
    if ('error' in resolved) {
      return { error: resolved.error };
    }
    const value = resolved.value;

    const sandbox = await ctx.getSandbox();
    // Scoped to THIS call only — see file comment above. Never persisted
    // to ~/.entry_env or any other file, never exported into the
    // sandbox's ambient/default env.
    const result = await sandbox.run({ command, env: { [envVarName]: value } });

    // Defense in depth: scrub the literal secret out of anything that
    // comes back, in case a CLI/API echoed it (e.g. in a printed URL or
    // an error message) — the model must never see the raw value even
    // by accident.
    const redact = (s: string) => (s ? s.split(value).join('[REDACTED]') : s);

    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
  },
};

injectCredentialTool.execute = safeExecute('inject_credential', injectCredentialTool.execute) as typeof injectCredentialTool.execute;
