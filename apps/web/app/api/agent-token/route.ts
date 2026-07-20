/**
 * Mints a short-lived service-to-service JWT the BROWSER uses to call the
 * agent directly when it's hosted off-Vercel (Pxxl) instead of in-process
 * via `withEve()`. Part of the Pxxl migration (see PXXL_MIGRATION.md) --
 * only actually exercised when NEXT_PUBLIC_EVE_AGENT_HOST is set; unused
 * and harmless otherwise.
 *
 * WHY THE BROWSER TALKS DIRECTLY TO THE AGENT HOST INSTEAD OF APPS/WEB
 * PROXYING THE REQUEST: proxying the long-lived NDJSON stream through a
 * Vercel Function would just re-impose the exact 300s cap this whole
 * migration exists to remove. So the browser has to open that connection
 * itself, straight to the Pxxl host -- which means it needs its own
 * credential, since it won't have (and cross-origin wouldn't even send)
 * the Better Auth session cookie that same-origin calls use today.
 *
 * This route mints that credential: verifies the caller's real Better
 * Auth session (same check as /api/internal/session), then signs a short
 * HS256 JWT (`sub`=user.id, `iss`='entry-web', `aud`='entry-agent') using
 * the SAME `EVE_INTERNAL_JWT_SECRET` apps/agent/agent/channels/eve.ts
 * already has a verifier for (`jwtHmac()`, previously unused because that
 * secret was never set in production -- see the long comment in that
 * file). `sub` becomes `ctx.session.auth.current.principalId` on the
 * agent side, same field every tool implementation already reads --
 * `jwtHmac`'s `principalType` comes back as `'service'` instead of
 * `'user'`, but nothing in this codebase branches on `principalType`
 * (confirmed via grep), only `principalId`, so behavior is identical.
 *
 * Deliberately short-lived (5 min) and re-minted before every request/
 * reconnect by the client (`eve/client`'s `ClientAuth.bearer` accepts a
 * `TokenValue` thunk it calls before each HTTP call) rather than a long-
 * lived token handed to the browser once.
 */
import { SignJWT } from 'jose';
import { getUserSessionFromRequest } from '@entry/auth';

const AUDIENCE = 'entry-agent';
const ISSUER = 'entry-web';
const TOKEN_TTL_SECONDS = 300;

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const secret = process.env.EVE_INTERNAL_JWT_SECRET;
  if (!secret) {
    // Fails closed -- same posture as the agent's own jwtHmac() gate,
    // which only activates when this same secret is set. No secret
    // configured means the off-Vercel agent host isn't in use yet.
    return Response.json({ error: 'agent_host_not_configured' }, { status: 501 });
  }

  const { user } = session;
  const token = await new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));

  return Response.json({ token, expiresInSeconds: TOKEN_TTL_SECONDS });
}
