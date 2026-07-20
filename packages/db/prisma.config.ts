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
    // `env('DATABASE_URL')` (Prisma's own helper) throws EAGERLY and
    // unconditionally at config-load time if the var is unset. That's fine
    // on hosts where DATABASE_URL is always present even during
    // install/build (Vercel), but Pxxl's build step runs on a separate
    // "buildserver" machine that never receives the project's runtime env
    // vars at all (only the later "spaceship" runtime container does) --
    // confirmed via a real Pxxl build failure: "PrismaConfigEnvError:
    // Cannot resolve environment variable: DATABASE_URL" during
    // postinstall's `prisma generate`, on a project with DATABASE_URL
    // correctly pushed and present at runtime.
    //
    // `prisma generate` (what postinstall runs) only reads schema.prisma
    // to emit the client -- it never opens a real connection, so a
    // syntactically-valid placeholder is enough to get past config
    // loading when the real var isn't there yet (build time). `migrate
    // deploy` and every real query DO need the genuine DATABASE_URL, and
    // both only ever run at runtime, where the real value is always
    // injected on every host this app deploys to -- so this fallback is
    // never live for anything that actually touches the database.
    url: process.env.DATABASE_URL
      ? env('DATABASE_URL')
      : 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
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
