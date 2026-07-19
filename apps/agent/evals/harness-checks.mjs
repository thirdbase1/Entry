/**
 * Harness regression checks — run after ANY change to persona.ts or
 * code_artifact.ts:
 *
 *   node apps/agent/evals/harness-checks.mjs   (from repo root)
 *
 * Zero network, zero API keys, <5s: structural invariants of the
 * prompt/tool layer, not model-quality evals. Each check exists because
 * its failure mode actually happened. Exits non-zero on any failure so
 * it can gate CI or a pre-push hook.
 *
 * Uses esbuild to compile the TS sources on the fly (no ts-node dep).
 */
import { execSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const compile = (src, out, externals) =>
  execSync(
    `npx esbuild ${src} --bundle --platform=node --format=cjs --outfile=${out} ${externals.map(e => `--external:${e}`).join(' ')}`,
    { cwd: root, stdio: 'pipe' },
  );

compile('apps/agent/agent/lib/persona.ts', '/tmp/eval-persona.cjs', ['zod', 'ai']);
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { buildPersonaInstructions } = require('/tmp/eval-persona.cjs');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// --- persona invariants ---------------------------------------------------

check('renders without throwing for all option combos', () => {
  for (const includeAgentDelegation of [true, false])
    for (const workingMemory of [null, 'User likes terse answers.'])
      for (const availableTools of [undefined, [], ['bash', 'web_search']]) {
        const s = buildPersonaInstructions({ includeAgentDelegation, workingMemory, availableTools });
        assert(s.length > 2000, 'suspiciously short prompt');
      }
});

check('no duplicated top-level blocks (the 2026-07-19 double-paste bug)', () => {
  const s = buildPersonaInstructions({ availableTools: ['bash'] });
  for (const block of ['<output_quality>', '<response_workflow_guidelines>', '<interaction_rules>', '<available_tools>', '<tool-calling-guidelines>'])
    assert.equal((s.match(new RegExp(block, 'g')) ?? []).length, 1, `${block} appears more than once`);
});

check('available_tools block present iff a list is given', () => {
  const withTools = buildPersonaInstructions({ availableTools: ['web_search', 'bash'] });
  assert(withTools.includes('<available_tools>'));
  assert(withTools.includes('bash, web_search'), 'tools should be sorted and listed');
  assert(!buildPersonaInstructions({}).includes('<available_tools>'));
});

check('operating loop, recovery protocol, and design bar all present', () => {
  const s = buildPersonaInstructions({});
  for (const m of ['1. **Understand**', '4. **Verify**', '5. **Recover**', 'vanished workspace', 'HARD BAN on emoji', 'Completeness checklist', '--accent:#0d9488', 'delve'])
    assert(s.includes(m), `missing: ${m}`);
});

check('agent-delegation guidance only for root sessions', () => {
  // The 2026-07-15 AI_NoSuchToolError bug: a child session being told
  // about an `agent` tool it doesn't have.
  const root = buildPersonaInstructions({ includeAgentDelegation: true });
  const child = buildPersonaInstructions({ includeAgentDelegation: false });
  assert(root.length > child.length, 'root prompt should be strictly longer than child');
});

check('every backtick-quoted tool-like name in prose is a real tool', () => {
  // The `todo` incident: prose referencing a tool that exists nowhere.
  const realTools = ['choose', 'web_crawl', 'web_search', 'task_analysis', 'code_artifact', 'python_coding', 'bash', 'read_file', 'write_file', 'edit_file', 'append_file', 'list_files', 'browser_use', 'browser_stop', 'save_credential', 'list_credentials', 'inject_credential', 'create_skill', 'list_skills', 'recall_skill', 'get_preview_url', 'restart_sandbox', 'remember_about_user', 'agent'];
  const s = buildPersonaInstructions({ includeAgentDelegation: true, availableTools: realTools });
  const nonTools = new Set(['old_text', 'new_text', 'entry-vercel-deploy-lessons', 'session_id', 'needs_connect']); // legit non-tool identifiers in prose
  const referenced = [...s.matchAll(/\\?`([a-z][a-z0-9_]{2,30})\\?`/g)].map(m => m[1]).filter(n => n.includes('_'));
  const unknown = [...new Set(referenced)].filter(n => !realTools.includes(n) && !nonTools.has(n));
  assert.deepEqual(unknown, [], `prompt references unknown tool-like names: ${unknown.join(', ')}`);
});

// --- code_artifact lint ---------------------------------------------------

// Extract just the pure lint function (the full module imports the AI SDK).
execSync(`awk '/^export function lintArtifactHtml/,/^}/' apps/agent/agent/lib/tool-impls/code_artifact.ts > /tmp/eval-lint.ts`, { cwd: root });
compile('/tmp/eval-lint.ts', '/tmp/eval-lint.cjs', []);
const { lintArtifactHtml } = require('/tmp/eval-lint.cjs');

check('artifact lint: clean HTML passes, broken HTML is flagged', () => {
  const good = '<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>Hi</h1><button>Go</button><script>console.log(1)</script></body></html>';
  assert.deepEqual(lintArtifactHtml(good), []);
  assert(lintArtifactHtml('<html><body><script>let x=1;').length > 0, 'truncated script not flagged');
  assert(lintArtifactHtml('<html><body></body></html>').length > 0, 'empty shell not flagged');
  assert(lintArtifactHtml(good.replace('Hi', 'Hi 🚀')).some(w => w.includes('emoji')), 'emoji not flagged');
  assert(lintArtifactHtml(good.replace('<h1>', '<img src="https://x.com/a.png"><h1>')).some(w => w.includes('external')), 'external resource not flagged');
});

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall harness checks passed');
process.exit(failed ? 1 : 0);
