/**
 * Prisma Client instantiation for Prisma ORM v7.
 *
 * v7 requires a driver adapter for every database (checked live via
 * `prisma generate` against the real installed 7.8.0 CLI, not just docs
 * prose — the old `datasources: { db: { url } }` constructor shape and a
 * schema-level `url` are both rejected now, P1012). Postgres uses
 * `@prisma/adapter-pg` wrapping a real `pg` connection pool.
 *
 * Schema itself (schema.prisma) is otherwise a 1:1 copy of the original
 * repo's 23 models — only the generator/datasource blocks changed for v7.
 *
 * Lazy singleton via Proxy: caught a real bug building this against actual
 * `next build` (not assumed) — Next.js's "collect page data" step imports
 * every route module at build time to extract static metadata, without
 * ever calling the handler. An eagerly-constructed client at module scope
 * (`export const prisma = createClient()`) throws immediately if
 * DATABASE_URL isn't present in the build environment, which is normal for
 * CI/build steps that don't need a live DB. Standard Next.js+Prisma
 * practice is exactly this: defer construction to first actual property
 * access.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client';

let globalPrisma: PrismaClient | undefined;

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const adapter = new PrismaPg({
    connectionString,
    // v7 uses node-pg which enforces valid SSL certs by default.
    // Default: strict (undefined = pg uses its default strict behavior).
    // Set DATABASE_SSL_STRICT=false only if your provider's cert chain isn't
    // in Node's CA bundle and you can't wire NODE_EXTRA_CA_CERTS.
    ssl: process.env.DATABASE_SSL_STRICT === 'false' ? { rejectUnauthorized: false } : undefined,
  });

  return new PrismaClient({ adapter });
}

function getClient(): PrismaClient {
  return globalPrisma ?? (globalPrisma = createClient());
}

// Reuse one client across hot-reloads / warm serverless invocations, same
// pattern the original NestJS PrismaModule effectively got for free via DI
// singleton scope — but only construct it lazily, on first real use.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient() as object, prop, receiver);
  },
});

export * from './generated/client';
export * from './generated/enums';
