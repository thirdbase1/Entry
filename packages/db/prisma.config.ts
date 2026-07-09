import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma ORM v7 config (replaces v6's datasource url/directUrl living only in
// schema.prisma). Confirmed required shape via prisma.io/docs/guides/upgrade-prisma-orm/v7.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
    // SHADOW_DATABASE_URL is only used by `migrate dev` (to detect drift by
    // replaying migrations against a scratch DB) — `migrate deploy` (what
    // production/CI actually runs) never touches it. Prisma's `env()`
    // helper throws eagerly and unconditionally if the var it names is
    // unset, which broke `npm run build` on Vercel (no SHADOW_DATABASE_URL
    // configured there, nor should there need to be one for a deploy-only
    // pipeline). Read it via plain process.env instead so it's simply
    // omitted when absent, and `migrate deploy` never notices either way.
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: env('SHADOW_DATABASE_URL') }
      : {}),
  },
});
