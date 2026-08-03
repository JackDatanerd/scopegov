// lib/utils/backup-codes.ts
// Generation, hashing, and verification for MFA recovery backup codes.
// Server-only (uses Node's crypto module).

import { randomInt, createHash } from 'crypto'

const CODE_COUNT = 8
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // no 0/O/1/I — avoids transcription errors

function randomCode(): string {
  let out = ''
  for (let i = 0; i < 10; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`
}

export function hashBackupCode(code: string): string {
  // Codes are compared case/whitespace-insensitively — normalize before hashing
  // so a user pasting "ab3d4-fg7h8" still matches what was displayed as uppercase.
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '')
  return createHash('sha256').update(normalized).digest('hex')
}

/** Generates a fresh set of plaintext backup codes and their hashes for storage. */
export function generateBackupCodes(): { plaintext: string[]; hashes: string[] } {
  const plaintext = Array.from({ length: CODE_COUNT }, randomCode)
  const hashes = plaintext.map(hashBackupCode)
  return { plaintext, hashes }
}
