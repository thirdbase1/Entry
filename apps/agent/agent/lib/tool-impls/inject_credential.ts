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
    'choose inside `command` (e.g. envVarName "GITHUB_TOKEN", command \'git push https://x-access-token:' +
    "$GITHUB_TOKEN@github.com/user/repo.git'). For github, the correct git auth header is now applied " +
    'automatically regardless of the URL username you type, so a 403 is NOT a URL-format problem anymore. ' +
    'If `git push` (or any Contents/Git-Data write call) still 403s here even though a permissions check ' +
    'against the same token reported push access, that combination has ONE specific real cause, not a ' +
    '"read-only integration" or platform limitation: this exact repository is not in the GitHub App ' +
    "installation's selected-repositories list (the installation may be scoped to other repos, or to " +
    '"Only select repositories" without this one checked). Do not conclude the integration is broken or ' +
    'read-only from this — tell the user plainly: go to https://github.com/settings/installations, find ' +
    'this app, click Configure, and either add this specific repository to the list or switch it to "All ' +
    'repositories" — then retry. That is the actual fix, and it is something only the user can do (repo ' +
    'selection lives on GitHub\'s side, not something any token/reconnect on our end can grant). This only ' +
    'affects this single command — it does NOT persist for any later bash call, by design.',
  inputSchema: z.object({
    service: z.string().describe('Which saved credential to use, e.g. "github", "vercel"'),
    label: z.string().optional().describe('Only needed if more than one credential is saved for this service. Defaults to "default".'),
    envVarName: z.string().describe('The environment variable name to expose it as for this one command, e.g. "GITHUB_TOKEN"'),
    command: z.string().describe(
      'The single shell command to run with that env var set. For github pushes/clones use the literal ' +
      'username "x-access-token", e.g. \'git push https://x-access-token:$GITHUB_TOKEN@github.com/user/repo.git\' ' +
      '— using the token alone as the username (no "x-access-token:" prefix) returns a misleading 403 ' +
      'Permission-denied even when the underlying grant has write access. Reference the credential only ' +
      'via $envVarName — never type the literal secret value.'
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
      // Pass the full structured error through (needsConnect/service/
      // connectMode) — the chat renderer uses those fields to show an
      // inline IntegrationConnectCard instead of the model having to
      // explain in prose where to go. See connect-service-tokens.ts.
      return resolved;
    }
    const value = resolved.value;

    const sandbox = await ctx.getSandbox();
    // GITHUB 403-DESPITE-CORRECT-PERMS FIX (2026-07-18, real bug reported:
    // a full clone/install/audit/build/push pipeline completed cleanly —
    // the model's own permissions probe against the GitHub API even came
    // back {admin:true, push:true, ...} for this exact token — yet the
    // `git push` in that same command still 403'd, and the model
    // concluded from that combination that "GitHub Connect is read-only
    // at the platform level," which is wrong: this tool's own description
    // already documents the actual cause below it never reliably follows
    // step by step several commands into one long generated script --
    // GitHub's App user-access tokens (ghu_...) need the URL username to
    // be the literal string "x-access-token", and a git remote URL typed
    // as https://$TOKEN@github.com/... (token as the username, no
    // "x-access-token:" prefix) gets a 403 from git's own auth handling
    // even though the SAME token has real write access — which is
    // exactly why the permissions probe (a plain Authorization-header API
    // call, unaffected by this) can report push:true while git itself
    // still rejects it. Rather than keep relying on the model to type the
    // URL in the one exact required shape every single time (proven
    // unreliable across a whole saga of these), force-apply the
    // credential via git's own `http.extraheader` config through extra
    // env vars alongside the model's chosen one -- this is honored by any
    // git subcommand automatically (no --global, nothing written to
    // disk) and OVERRIDES whatever auth the URL itself does or doesn't
    // have, so it now works regardless of the exact URL shape the model
    // generates.
    const githubExtraEnv: Record<string, string> =
      service.toLowerCase() === 'github'
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`,
          }
        : {};
    // Scoped to THIS call only — see file comment above. Never persisted
    // to ~/.entry_env or any other file, never exported into the
    // sandbox's ambient/default env.
    const result = await sandbox.run({ command, env: { [envVarName]: value, ...githubExtraEnv } });

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
