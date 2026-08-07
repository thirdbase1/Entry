#!/usr/bin/env node
/**
 * Generates apps/agent/agent/lib/generated/skills-catalog.json from every
 * apps/agent/agent/skills/<slug>/SKILL.md on disk.
 *
 * WHY A GENERATED JSON FILE INSTEAD OF A RUNTIME fs.readdir() (2026-08-07):
 * apps/agent/agent/skills/ is a plain directory of markdown files, not
 * something any code statically imports -- Next.js/Vercel's build-time
 * file tracer (@vercel/nft) only bundles files it can see are actually
 * required by traced code. A runtime `fs.readFile('.../SKILL.md')` call
 * would work fine in local dev but silently find nothing once deployed,
 * because the raw .md files never make it into the Vercel Lambda's
 * bundle. Generating this JSON file at build time and having
 * list_skills.ts / recall_skill.ts `import` it directly sidesteps that
 * entirely -- a statically imported file is ordinary bundler input, no
 * special tracing config needed, same guarantee as any other imported
 * module.
 *
 * Run this any time a skill under apps/agent/agent/skills/ is
 * added/edited/removed, then commit the regenerated JSON alongside the
 * source change -- this is intentionally checked into git (not
 * .gitignored) so a build never silently uses a stale catalog if this
 * script isn't re-run.
 *
 * Frontmatter here is deliberately simple (one `description: "..."`
 * string, optional one-line `metadata: {...}` JSON) -- not full YAML --
 * so this is a small hand-rolled parser instead of pulling in a new
 * dependency (gray-matter/js-yaml) for a two-field format.
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(__dirname, '..', 'agent', 'skills');
const outPath = join(__dirname, '..', 'agent', 'lib', 'generated', 'skills-catalog.json');

function parseFrontmatterDescription(raw) {
  // Extract the `description: "...json-escaped..."` line's value,
  // tolerating embedded escaped quotes -- same shape as a JSON string
  // literal, so lean on JSON.parse for the unescaping rather than a
  // hand-rolled unescaper.
  const match = raw.match(/^description:\s*"((?:[^"\\]|\\.)*)"/m);
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function loadSkill(slug) {
  const dir = join(skillsRoot, slug);
  const skillMdPath = join(dir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  const raw = readFileSync(skillMdPath, 'utf8');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter -- treat the whole file as instructions, no
    // description (list_skills will just show the slug).
    return { slug, description: '', instructions: raw.trim(), hasResources: dirHasResources(dir) };
  }
  const [, frontmatter, body] = fmMatch;
  const description = parseFrontmatterDescription(frontmatter);
  return { slug, description, instructions: body.trim(), hasResources: dirHasResources(dir) };
}

function dirHasResources(dir) {
  return ['scripts', 'references', 'resources', 'rules'].some(sub => existsSync(join(dir, sub)));
}

function main() {
  if (!existsSync(skillsRoot)) {
    console.error(`No skills directory at ${skillsRoot}`);
    process.exit(1);
  }
  const entries = readdirSync(skillsRoot).filter(name => {
    const full = join(skillsRoot, name);
    return statSync(full).isDirectory();
  });

  const skills = entries
    .map(loadSkill)
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const catalog = {
    generatedAt: new Date().toISOString(),
    skills,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Wrote ${skills.length} built-in skills to ${outPath}`);
  for (const s of skills) console.log(`  - ${s.slug}${s.hasResources ? ' (has scripts/references)' : ''}`);
}

main();
