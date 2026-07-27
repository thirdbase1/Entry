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

check('extended slop ban and design themes present in persona', () => {
  const s = buildPersonaInstructions({});
  for (const m of ['EXTENDED SLOP BAN', 'gradient text', 'nested cards', 'Inter/sans monoculture', 'bounce/spring easing', 'dark glow', 'monotonous spacing', 'Typographic pairing required', 'Warm editorial', 'Cool technical', 'Dark premium', 'High-contrast minimal', 'Soft pastel', 'tinted neutral', 'Self-critique'])
    assert(s.includes(m), `missing design bar element: ${m}`);
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
execSync("awk 'NR>=1{lines[NR]=$0} END{found=0; for(i=1;i<=NR;i++){if(lines[i]~/^export function lintArtifactHtml/) found=1; if(found) print lines[i]; if(found && lines[i]~/^}$/ && i>start+3) {found=0}}}' apps/agent/agent/lib/tool-impls/code_artifact.ts > /tmp/eval-lint.ts", { cwd: root });
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

// --- AI slop detection (2026-07-27) --------------------------------------

check('slop lint: gradient text is flagged', () => {
  const html = '<style>.hero h1{background:linear-gradient(135deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent}</style><div class="hero"><h1>AI Slop</h1></div>';
  assert(lintArtifactHtml(html).some(w => w.includes('gradient text')), 'gradient text not flagged');
});

check('slop lint: nested cards are flagged', () => {
  const html = '<div class="card"><div class="card-inner"><h2>X</h2></div></div><div class="card"><p>Y</p></div><div class="card"><p>Z</p></div>';
  assert(lintArtifactHtml(html).some(w => w.includes('nested cards')), 'nested cards not flagged');
});

check('slop lint: Inter monoculture is flagged', () => {
  const html = '<style>body{font-family:Inter,sans-serif}h1{font-family:Inter,sans-serif}h2{font-family:Inter,sans-serif}</style><h1>Hi</h1>';
  assert(lintArtifactHtml(html).some(w => w.includes('single-font monoculture') || w.includes('monoculture')), 'Inter monoculture not flagged');
});

check('slop lint: bounce easing is flagged', () => {
  const html = '<style>.card{transition:transform .3s cubic-bezier(0.175,0.885,0.32,1.275)}button{transition:all .2s ease}</style><div class="card">X</div>';
  assert(lintArtifactHtml(html).some(w => w.includes('bounce')), 'bounce easing not flagged');
});

check('slop lint: dark glow is flagged', () => {
  const html = '<style>body{background:#000}.card{box-shadow:0 0 20px #6366f1}</style><div class="card">X</div>';
  assert(lintArtifactHtml(html).some(w => w.includes('dark glow')), 'dark glow not flagged');
});

check('slop lint: clean design passes without slop warnings', () => {
  const good = '<!doctype html><html><head><style>body{font:16px/1.5 system-ui;background:#fafaf9;color:#1c1917;margin:0}h1{font-family:Georgia,serif;font-weight:700}.card{background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:24px}</style></head><body><h1>Hi</h1><div class="card"><p>Content</p></div></body></html>';
  const warnings = lintArtifactHtml(good).filter(w => w.includes('slop') || w.includes('gradient') || w.includes('nested') || w.includes('monoculture') || w.includes('bounce') || w.includes('dark glow') || w.includes('monotonous') || w.includes('eyebrow'));
  assert.deepEqual(warnings, [], 'clean design should not trigger slop warnings, got: ' + warnings.join('; '));
});


console.log(failed ? `\n${failed} check(s) FAILED` : '\nall harness checks passed');