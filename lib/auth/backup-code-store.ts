// lib/auth/backup-code-store.ts
//
// Issue a fresh set of backup codes for a user, invalidating any earlier unused
// ones. Shared by /api/auth/mfa/verify (first enrolment) and
// /api/auth/mfa/backup-codes (regenerate).
//
// ATOMIC (migration 066, issue_backup_codes): retiring the old codes and
// inserting the new ones happen in ONE transaction under an advisory lock. The
// previous two-statement version (a) only logged a failure to retire the old
// codes while telling the person they no longer worked, and (b) let two
// concurrent regenerations leave both sets valid.

import { generateBackupCodes } from '@/lib/utils/backup-codes'

export async function issueBackupCodes(service: any, userId: string): Promise<string[]> {
  const { plaintext, hashes } = generateBackupCodes()
  const { error } = await service.rpc('issue_backup_codes', { p_user: userId, p_hashes: hashes })
  if (error) throw new Error(error.message)
  return plaintext
}
