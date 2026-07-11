#!/usr/bin/env node
/**
 * Guard in front of `prisma migrate deploy` — refuses to run if
 * `DATABASE_URL` obviously isn't a real production database.
 *
 * Why this exists (2026-07-11, real incident): `npm run build`'s
 * `db:deploy` step ran `prisma migrate deploy` against whatever
 * `DATABASE_URL` happened to be exported in the shell at build time. This
 * project's documented deploy flow (DEPLOY.md "Step 4") builds LOCALLY
 * (Vercel's own remote build orchestration is broken for this project —
 * see that file), so "build time" here means a developer's/operator's own
 * shell — and Neon's Vercel integration does not let `vercel env pull` /
 * `vercel env ls` export the real production `DATABASE_URL` value at all
 * (confirmed: it comes back as a literal empty string). Nothing stopped
 * `.env`'s local dev `DATABASE_URL` (e.g. `localhost:5432/entry_demo`)
 * from silently being used instead — the migrate step reported success
 * ("no pending migrations" against the WRONG database), while production
 * itself never got the migration and broke at runtime with a genuine
 * `table does not exist` error the moment a user hit that code path.
 *
 * This makes that failure mode loud and immediate instead of silent:
 * fails the build with a clear message if `DATABASE_URL` matches an
 * obvious local/placeholder pattern, forcing whoever's deploying to
 * explicitly provide the real production connection string (from the
 * Neon dashboard/API or `neonctl connection-string`, since the Vercel CLI
 * can't supply it) rather than an accidental leftover of `.env`.
 */
// Conscious escape hatch for a deploy that has zero new migration
// folders since the last release (verified by whoever's deploying) —
// production migrations for this project are applied via the permanent
// `POST /api/admin/db/migrate` route instead (see DEPLOY.md's note on
// this), precisely because Neon's Vercel integration makes the real
// DATABASE_URL fundamentally unobtainable from a local shell. This is
// NOT a way around the guard's actual purpose (catching an ACCIDENTAL
// silent run against the wrong DB) — it's an explicit, deliberate
// opt-out for the specific case the guard can't tell apart from that on
// its own: a build where migrating isn't needed at all this time.
if (process.env.SKIP_PRODUCTION_MIGRATE_GUARD === '1') {
  console.log(
    '[guard-production-migrate] SKIP_PRODUCTION_MIGRATE_GUARD=1 set — skipping the local `prisma migrate\n' +
      'deploy` step entirely. Only use this when you have verified there are no new migration folders since\n' +
      'the last deploy; if there ARE, apply them via `POST /api/admin/db/migrate` after deploying instead.'
  );
  process.exit(0);
}

const url = process.env.DATABASE_URL || '';

const localPatterns = [/localhost/i, /127\.0\.0\.1/i, /entry_demo/i, /::1/];

if (!url) {
  console.error(
    '\n[guard-production-migrate] DATABASE_URL is not set at all — refusing to run `prisma migrate deploy`.\n' +
      'Set it to the REAL production connection string before building (Neon dashboard → your prod branch\n' +
      '→ Connection Details, or `neonctl connection-string <prod-branch>`). Vercel\'s CLI cannot supply this\n' +
      'value for Neon-integration-managed vars — `vercel env pull`/`env ls` return it as empty by design.\n'
  );
  process.exit(1);
}

if (localPatterns.some(p => p.test(url))) {
  console.error(
    `\n[guard-production-migrate] DATABASE_URL looks like a LOCAL/dev database (${url.replace(/:[^:@]*@/, ':****@')}).\n` +
      'Refusing to run `prisma migrate deploy` against it as part of a production build — this is exactly\n' +
      'the bug that left production missing the chat_previews table on 2026-07-11 (migrate deploy "succeeded"\n' +
      'against a local DB while real production silently never got the migration).\n\n' +
      'Export the REAL production DATABASE_URL before building, e.g.:\n' +
      '  export DATABASE_URL="<production connection string from Neon dashboard / neonctl>"\n' +
      '  npm run build\n'
  );
  process.exit(1);
}

console.log('[guard-production-migrate] DATABASE_URL looks like a real (non-local) database — proceeding with migrate deploy.');

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const prismaCli = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
