/**
 * Internal session-verification endpoint — used by apps/agent (the eve
 * channel) to authenticate a real user's Better Auth session cookie
 * without importing `better-auth` (and its @better-auth/core otel
 * instrumentation, which triggers a dynamic `import("@opentelemetry/api")`)
 * into the agent's Rolldown-bundled, single-chunk serverless function.
 *
 * apps/web already imports the full `@entry/auth` package elsewhere (e.g.
 * app/api/chats/route.ts), so this route adds zero new bundle weight here
 * — it just exposes the existing getUserSessionFromRequest() check over
 * HTTP so the agent process can call it with the forwarded cookie header
 * instead of re-implementing/re-bundling session verification itself.
 *
 * Security: this only echoes back whatever the *caller's own* forwarded
 * cookies already authenticate as — same trust boundary as calling
 * auth.api.getSession() directly. No separate secret needed; a request
 * with no/invalid session cookie simply gets `{ user: null }`.
 */
import { getUserSessionFromRequest } from '@entry/auth';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ user: null });

  const { user } = session;
  return Response.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
}
