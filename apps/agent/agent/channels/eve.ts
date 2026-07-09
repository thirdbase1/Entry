/**
 * Route-auth policy for this agent's built-in `/eve/v1/session*` HTTP API
 * (see eve/docs/guides/auth-and-route-protection.md, read directly from the
 * installed package this session — not assumed).
 *
 * This agent is called by exactly one first-party caller: apps/web's Route
 * Handlers proxy browser chat traffic to here (see
 * apps/web/lib/eve-server.ts). That's a server-to-server call, not end-user
 * browser traffic reaching this origin directly, so `jwtHmac()` (a shared
 * HS256 secret both sides hold) is the right fit — simpler than standing up
 * OIDC for a same-org internal hop, and unlike `localDev()` it still works
 * once both apps are deployed to separate Vercel projects. `localDev()` is
 * kept as a second entry purely so `eve dev` keeps working stand-alone
 * (e.g. `eve info`, manual curl testing) without needing a minted token.
 *
 * EVE_INTERNAL_JWT_SECRET must be the same value configured on apps/web's
 * EVE_INTERNAL_JWT_SECRET — this is a shared secret, not two different
 * keys. Generate one long random string once and set it in both apps.
 */
import { eveChannel } from 'eve/channels/eve';
import { jwtHmac, localDev } from 'eve/channels/auth';

const secret = process.env.EVE_INTERNAL_JWT_SECRET;

export default eveChannel({
  auth: [
    ...(secret
      ? [
          jwtHmac({
            algorithm: 'HS256' as const,
            issuer: 'entry-web',
            audiences: ['entry-agent'],
            secret,
          }),
        ]
      : []),
    localDev(),
  ],
});
