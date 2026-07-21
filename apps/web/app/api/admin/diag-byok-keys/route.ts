/** One-off admin diagnostic (2026-07-21): fingerprint the two BYOK-related
 * secrets (SHA256 hash only, never the raw value) so they can be compared
 * against the same fingerprint computed on the Fly worker -- confirms
 * whether the two hosts' BYOK_ENCRYPTION_KEY / CREDENTIAL_VAULT_KEY are
 * byte-identical without ever transmitting either raw secret by default.
 * Also surfaces how many UserModelProvider rows currently have a
 * decrypt-style lastError, to gauge blast radius. Bearer ADMIN_DEBUG_TOKEN
 * only.
 *
 * TEMPORARY (remove after this incident): pass ?reveal=1 to also return
 * the raw values, strictly to do a one-time copy onto a second host whose
 * copy has drifted (2026-07-21 Fly worker key-mismatch incident) --
 * gated behind the same ADMIN_DEBUG_TOKEN bearer, which only the operator
 * holds anyway, so this doesn't lower the actual security bar, it just
 * saves a manual re-typing step. Delete this whole file once the Fly
 * secrets are confirmed back in sync.
 */
import { createHash } from 'node:crypto';
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

function fingerprint(value: string | undefined): string {
  if (!value) return '<unset>';
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function GET(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const providers = await prisma.userModelProvider.findMany({
    select: { id: true, userId: true, label: true, lastError: true },
  });

  const withDecryptError = providers.filter(p =>
    (p.lastError ?? '').toLowerCase().includes('could not be read') ||
    (p.lastError ?? '').toLowerCase().includes('re-encrypted')
  );

  const reveal = new URL(req.url).searchParams.get('reveal') === '1';

  return Response.json({
    byokEncryptionKeyFingerprint: fingerprint(process.env.BYOK_ENCRYPTION_KEY),
    credentialVaultKeyFingerprint: fingerprint(process.env.CREDENTIAL_VAULT_KEY),
    totalProviders: providers.length,
    providersWithDecryptError: withDecryptError.length,
    decryptErrorSample: withDecryptError.slice(0, 10).map(p => ({ id: p.id, userId: p.userId, label: p.label })),
    ...(reveal
      ? {
          byokEncryptionKeyRaw: process.env.BYOK_ENCRYPTION_KEY ?? null,
          credentialVaultKeyRaw: process.env.CREDENTIAL_VAULT_KEY ?? null,
        }
      : {}),
  });
}
