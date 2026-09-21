// lib/utils/backup-codes.ts
// Generation, hashing, and verification for MFA recovery backup codes.
// Server-only (uses Node's crypto module).
//
// Hardening (audit round 2): codes are 60 bits (was 50) and are stored as an
// HMAC-SHA256 keyed with MFA_BACKUP_CODE_PEPPER (a server-only secret) instead of
// an UNSALTED SHA-256. With a plain fast hash, one pass over the 2^50 code space
// checks every user's stored hash at once — a database leak made every backup
// code recoverable within hours on a few GPUs. The pepper is not in the
// database, so a leaked table alone no longer yields codes.
//
// Codes issued before this change (sha256 of the dashed, upper-cased code) keep
// working: verification tries BOTH digests (backupCodeCandidateHashes).

import { randomInt, createHash, createHmac } from 'crypto'

const CODE_COUNT = 8
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // no 0/O/1/I — avoids transcription errors
const HALF = 6

function randomCode(): string {
  let out = ''
  for (let i = 0; i < HALF * 2; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return `${out.slice(0, HALF)}-${out.slice(HALF)}`
}

function pepper(): string | null {
  const p = process.env.MFA_BACKUP_CODE_PEPPER
  return p && p.length >= 16 ? p : null
}

let warned = false
function warnNoPepper() {
  if (warned || process.env.NODE_ENV === 'test') return
  warned = true
  console.warn('[mfa] MFA_BACKUP_CODE_PEPPER is not set (or shorter than 16 chars): backup codes fall back to an unsalted SHA-256. Set it — README §2.1.')
}

/** Canonical form: whitespace and dashes stripped, upper-cased. */
export function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, '')
}

/** Legacy digest (migration 006 – 065): sha256 of the trimmed, upper-cased code WITH its dash. */
export function legacyBackupCodeHash(code: string): string {
  const legacy = code.trim().toUpperCase().replace(/\s+/g, '')
  return createHash('sha256').update(legacy).digest('hex')
}

/** Digest used to STORE newly issued codes. */
export function hashBackupCode(code: string): string {
  const normalized = normalizeBackupCode(code)
  const key = pepper()
  if (!key) {
    warnNoPepper()
    return createHash('sha256').update(normalized).digest('hex')
  }
  return createHmac('sha256', key).update(normalized).digest('hex')
}

/** Every digest a submitted code could have been stored under (new scheme, unpeppered new scheme, legacy). */
export function backupCodeCandidateHashes(code: string): string[] {
  const normalized = normalizeBackupCode(code)
  const out = new Set<string>([hashBackupCode(code), legacyBackupCodeHash(code)])
  out.add(createHash('sha256').update(normalized).digest('hex'))
  return Array.from(out)
}

/** Generates a fresh set of plaintext backup codes and their hashes for storage. */
export function generateBackupCodes(): { plaintext: string[]; hashes: string[] } {
  const plaintext = Array.from({ length: CODE_COUNT }, randomCode)
  const hashes = plaintext.map(hashBackupCode)
  return { plaintext, hashes }
}
