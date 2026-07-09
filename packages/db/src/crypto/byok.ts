/**
 * AES-256-GCM at-rest encryption for user-supplied BYOK provider API keys
 * (UserModelCredential.encryptedApiKey). One env secret
 * (BYOK_ENCRYPTION_KEY, 32 raw bytes, base64-encoded in the env var) backs
 * all rows — never the user's own key material, never logged, never
 * returned to the client after creation.
 *
 * Format stored in the DB column: `${ivB64}:${authTagB64}:${ciphertextB64}`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, standard for GCM

function getKey(): Buffer {
  const raw = process.env.BYOK_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'BYOK_ENCRYPTION_KEY is not set — required to store/read BYOK provider API keys. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`BYOK_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}.`);
  }
  return key;
}

export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptApiKey(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted BYOK value — expected "iv:authTag:ciphertext".');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Last-4-chars masked preview for UI display — never send the real key back to the client. */
export function maskApiKey(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}
