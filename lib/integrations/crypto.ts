// lib/integrations/crypto.ts
//
// Encryption at rest for integration secrets (webhook signing secrets now; OAuth access/refresh tokens for Slack,
// HubSpot and Google Drive later). AES-256-GCM with a per-value random IV.
//
//   INTEGRATIONS_ENCRYPTION_KEY           base64, exactly 32 bytes (openssl rand -base64 32). Required.
//   INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS  optional, same format: still DECRYPTS old values during a rotation.
//
// Stored format:  v1.<keyId>.<iv>.<tag>.<ciphertext>   (base64url parts; keyId = first 4 bytes of SHA-256(key), hex)
//
// `context` is bound in as GCM additional authenticated data (use `${workspaceId}:${rowId}`), so a ciphertext copied
// onto another row or another workspace fails to decrypt instead of quietly working.
//
// Fails CLOSED: with no key configured, encrypt/decrypt throw. Nothing falls back to plaintext.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export class IntegrationCryptoError extends Error {}

interface Key { id: string; bytes: Buffer }

function parseKey(raw: string | undefined, label: string): Key | null {
  if (!raw) return null
  const bytes = Buffer.from(raw.trim(), 'base64')
  if (bytes.length !== 32) throw new IntegrationCryptoError(`${label} must be 32 bytes, base64-encoded`)
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes }
}

function keys(env: NodeJS.ProcessEnv = process.env): { current: Key; previous: Key | null } {
  const current = parseKey(env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY')
  if (!current) throw new IntegrationCryptoError('INTEGRATIONS_ENCRYPTION_KEY is not configured')
  return { current, previous: parseKey(env.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS, 'INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS') }
}

/** True when integrations can store secrets. The UI uses this to say so instead of failing on save. */
export function integrationCryptoConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try { keys(env); return true } catch { return false }
}

const b64 = (b: Buffer) => b.toString('base64url')

export function encryptSecret(plaintext: string, context: string, env: NodeJS.ProcessEnv = process.env): string {
  const { current } = keys(env)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', current.bytes, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', current.id, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.')
}

export function decryptSecret(stored: string, context: string, env: NodeJS.ProcessEnv = process.env): string {
  const parts = String(stored || '').split('.')
  if (parts.length !== 5 || parts[0] !== 'v1') throw new IntegrationCryptoError('Unrecognised ciphertext format')
  const { current, previous } = keys(env)
  const key = [current, previous].find(k => k && k.id === parts[1])
  if (!key) throw new IntegrationCryptoError('No configured key matches this ciphertext')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(parts[2], 'base64url'))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    // Wrong key, wrong context, or tampered bytes: one indistinguishable failure.
    throw new IntegrationCryptoError('Could not decrypt value')
  }
}
