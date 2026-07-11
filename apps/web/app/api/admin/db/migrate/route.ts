import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';

/**
 * Permanent admin-only route that applies any pending Prisma migrations
 * directly against production, from inside the deployed function itself.
 *
 * Why this exists instead of just running `prisma migrate deploy` (2026-07-11):
 * this project's deploy flow (DEPLOY.md "Step 4") builds LOCALLY and hand-
 * assembles the Vercel deployment, because Vercel's own remote build
 * orchestration is broken for this project. That means `npm run build`'s
 * migration step (`db:deploy`) runs in a developer's own shell, not inside
 * Vercel — and Neon's Vercel integration does not let `vercel env pull` /
 * `vercel env ls` export the real production `DATABASE_URL` at all (it
 * comes back as a literal empty string; confirmed directly). Nothing
 * stopped a leftover local/dev `DATABASE_URL` from being used instead —
 * `migrate deploy` reported success against the WRONG database, while
 * production silently never got the migration and broke at runtime with a
 * genuine "table does not exist" error the moment a user hit that code
 * path (confirmed real incident: `chat_previews`, migration
 * `20260711170741_add_chat_preview`).
 *
 * `packages/db/scripts/guard-production-migrate.js` now makes the local
 * path fail loudly instead of silently succeeding against the wrong DB —
 * but there still needs to be a way to actually apply a migration to
 * production when the real connection string can't be obtained locally
 * at all. This route is that way: it runs inside the already-deployed
 * function, where `DATABASE_URL` resolves to the true production value,
 * and reimplements exactly what `prisma migrate deploy` does (compare the
 * migrations directory against `_prisma_migrations`, apply anything
 * missing in order, record it with its real checksum) using the migration
 * folder bundled in via `next.config.ts`'s `outputFileTracingIncludes`.
 *
 * Gated by a real admin session (same isAdmin check as /api/admin/users)
 * rather than a throwaway token, since — unlike the one-off route this
 * replaced — this is meant to stay in the codebase permanently as the
 * standing way to ship future migrations to production.
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const migrationsDir = join(process.cwd(), '..', '..', 'packages', 'db', 'prisma', 'migrations');

  let entries: string[];
  try {
    entries = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read migrations directory at ${migrationsDir}`, detail: String(err) },
      { status: 500 }
    );
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  );
  const appliedSet = new Set(applied.map(r => r.migration_name));

  const results: Array<{ migrationName: string; status: string }> = [];

  for (const migrationName of entries) {
    if (appliedSet.has(migrationName)) {
      results.push({ migrationName, status: 'already-applied' });
      continue;
    }

    const sqlPath = join(migrationsDir, migrationName, 'migration.sql');
    const sql = await readFile(sqlPath, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    await prisma.$transaction(async tx => {
      // Prisma migration files can contain multiple statements separated
      // by `;` — executed one at a time since $executeRawUnsafe doesn't
      // support multi-statement bodies the way a raw psql client would.
      const statements = sql
        .split(/;\s*(?:\n|$)/)
        .map(s => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, $1, now(), $2, now(), $3)`,
        checksum,
        migrationName,
        statements.length
      );
    });

    results.push({ migrationName, status: 'applied' });
  }

  return NextResponse.json({ results });
}

export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const migrationsDir = join(process.cwd(), '..', '..', 'packages', 'db', 'prisma', 'migrations');
  const entries = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  ).catch(() => [] as Array<{ migration_name: string }>);
  const appliedSet = new Set(applied.map(r => r.migration_name));

  return NextResponse.json({
    migrations: entries.map(name => ({ name, applied: appliedSet.has(name) })),
    pendingCount: entries.filter(name => !appliedSet.has(name)).length,
  });
}
