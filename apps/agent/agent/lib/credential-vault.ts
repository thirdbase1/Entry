/**
 * The secure credential vault (2026-07-11) — "a secure place in the
 * sandbox where AI can save credentials and when it wants to use them,
 * it does something inject auth."
 *
 * Design decisions, and why:
 *
 * 1. Encrypted at rest, not plaintext in the DB. AES-256-GCM with a
 *    server-only key (CREDENTIAL_VAULT_KEY, never sent to the client,
 *    never passed to a model) — a DB leak/backup/admin query alone
 *    cannot recover the plaintext value, only this process can (and only
 *    with that env var present).
 *
 * 2. The MODEL never sees the decrypted value. `get()` exists for other
 *    server-side code to call (e.g. inject_credential's tool-impl), but
 *    no tool-impl in this codebase ever returns a decrypted value in its
 *    result — that would put the secret straight into the model's own
 *    context window, from which it could be echoed back to the user,
 *    logged, or included in a later prompt. Every consumer must decrypt
 *    and USE the value entirely inside this process (e.g. as a header on
 *    an outbound fetch, or written directly into the sandbox's env),
 *    never hand it back up the call stack to a tool's return value.
 *
 * 3. `service` is freeform. Not an enum of known integrations — the "AI
 *    can register more types, many of them, by itself" request means
 *    save_credential must work for a service we've never hard-coded
 *    support for (the user just says "here's my Stripe key" and it's
 *    service: "stripe", no code change needed).
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { prisma } from '@entry/db';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_VAULT_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIAL_VAULT_KEY is not set — the credential vault is disabled until this env var is configured.'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_VAULT_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM.');
  }
  return key;
}

// Same "iv:authTag:ciphertext" (each base64) stored-format convention as
// packages/db/src/crypto/byok.ts's BYOK-key encryption — consistent and
// debuggable across the codebase's two independent at-rest-encryption
// subsystems. Deliberately a SEPARATE key (CREDENTIAL_VAULT_KEY, not
// BYOK_ENCRYPTION_KEY) since these are operationally distinct secret
// stores — rotating one should never require rotating the other.
function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted credential value — expected "iv:authTag:ciphertext".');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
}

export interface SaveCredentialInput {
  userId: string;
  service: string;
  label?: string;
  value: string;
}

export async function saveCredential({ userId, service, label = 'default', value }: SaveCredentialInput) {
  const encryptedValue = encrypt(value);
  await prisma.userCredential.upsert({
    where: { userId_service_label: { userId, service, label } },
    create: { userId, service, label, encryptedValue },
    update: { encryptedValue },
  });
}

/** Metadata only — service/label/timestamps, NEVER the value. Safe to
 *  return straight to the model so it knows what's already saved without
 *  re-asking the user, without ever exposing a secret. */
export async function listCredentials(userId: string) {
  const rows = await prisma.userCredential.findMany({
    where: { userId },
    select: { service: true, label: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  return rows;
}

/** Decrypts and returns the raw value. Server-side use ONLY — never
 *  return this directly from a tool's execute(). See file header. */
export async function getCredential(userId: string, service: string, label = 'default'): Promise<string | null> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_service_label: { userId, service, label } },
  });
  if (!row) return null;
  try {
    return decrypt(row.encryptedValue);
  } catch (err) {
    // FIXED (2026-07-20, same CREDENTIAL_VAULT_KEY-rotation incident as
    // byok.ts's decryptApiKey — see resolve-model.ts's fix comment for the
    // full story). A stale-key decrypt failure here must never throw a raw
    // crypto error up into a tool's execute() — this is server-side-only
    // credential injection, and inject_credential's caller (the persona)
    // is told an unreadable credential means "not actually usable", same
    // as it not existing at all, so it re-prompts the user to save it
    // again instead of the whole turn crashing.
    return null;
  }
}

export async function deleteCredential(userId: string, service: string, label = 'default') {
  await prisma.userCredential.deleteMany({ where: { userId, service, label } });
}
