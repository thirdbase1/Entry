/**
 * PXXL PORT (2026-07-20) -- HTTP/auth seam for BYOK / explicit-model chat
 * turns, running on this agent's own long-lived Pxxl process instead of
 * a Vercel Serverless Function. See direct-chat-core.ts for the actual
 * turn body (streamText loop, tool set, persistence) -- copied
 * near-verbatim from apps/web/app/api/direct/chat/route.ts and kept that
 * way on purpose so the two stay diffable as fixes land on either side.
 *
 * WHY THIS NEEDED ITS OWN FILE INSTEAD OF REUSING eve.ts's eveChannel:
 * eve's `model:` (agent.ts) is fixed at compile time for the whole
 * deployment -- there is no supported way to swap in a per-request,
 * per-user model through eve's own session/`send()` API (confirmed
 * directly from node_modules/eve/dist's public type defs: `model` is a
 * static `PublicAgentModelDefinition = LanguageModel`, not a per-session
 * resolver). BYOK/explicit-model turns pick a DIFFERENT model per
 * request (the user's own key, or an arbitrary Gateway model id), so
 * they can never go through eve's normal session runtime at all --
 * that's true on Vercel today (hence the separate /api/direct/chat
 * route) and stays true here. This file is a `custom channel`
 * (eve/channels' documented escape hatch for exactly this: "when eve
 * doesn't ship a channel for your surface, you build one") with its own
 * raw fetch handler that never calls eve's `send()`/session machinery at
 * all -- it runs its own streamText loop directly, same as the Vercel
 * route did.
 *
 * AUTH: verifies the short-lived HS256 JWT apps/web's /api/agent-token
 * route mints (same `EVE_INTERNAL_JWT_SECRET`, same shape --
 * `sub`=userId, `iss`='entry-web', `aud`='entry-agent' -- as eve.ts's own
 * `jwtHmac()` entry uses for the default chat path). Verified with
 * `jose` directly here (HMAC verify is a local, synchronous-cost
 * computation -- no network round trip), deliberately NOT via eve.ts's
 * loopback `/api/internal/session` cookie-check pattern: that path
 * exists only because a browser's Better Auth session cookie can't be
 * validated without calling back to apps/web, but a bearer JWT is
 * self-verifying. Skipping that round trip is a real, measurable latency
 * win for every turn's very first byte, on top of removing the 300s
 * ceiling entirely -- see the file comment on ../lib/direct-chat/sandbox.ts
 * for the rest of the parity story.
 *
 * CORS: `cors: true` -- this endpoint is only ever called cross-origin,
 * by design (that's the entire point of this migration), so permissive
 * CORS is required, not optional, unlike eve.ts's channel where it's a
 * harmless same-origin no-op today.
 */
import { defineChannel, POST } from 'eve/channels';
import { jwtVerify } from 'jose';
import { runDirectChatTurn } from '../lib/direct-chat-core.js';

const AUDIENCE = 'entry-agent';
const ISSUER = 'entry-web';

async function verifyBearer(req: Request): Promise<{ userId: string } | null> {
  const secret = process.env.EVE_INTERNAL_JWT_SECRET;
  if (!secret) return null;
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

export default defineChannel({
  cors: {
    origin: [
      'https://entry.oneshotsx.cv',
      ...(process.env.ENTRY_WEB_ORIGIN ? [process.env.ENTRY_WEB_ORIGIN] : []),
    ],
    methods: ['POST'],
    allowHeaders: ['authorization', 'content-type'],
  },
  routes: [
    POST('/message', async (req, { waitUntil }) => {
      const principal = await verifyBearer(req);
      if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }

      try {
        return await runDirectChatTurn(principal.userId, body, waitUntil);
      } catch (err) {
        console.error('[direct-chat channel] uncaught error', err);
        return Response.json({ error: 'internal_error' }, { status: 500 });
      }
    }),
  ],
});
