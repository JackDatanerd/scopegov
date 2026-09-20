// lib/auth/backup-code-store.ts
//
// Issue a fresh set of backup codes for a user, invalidating any earlier unused
// ones. Shared by /api/auth/mfa/verify (first enrolment) and
// /api/auth/mfa/backup-codes (regenerate).
//
// FIX (build — Auth independent audit, LOW): regeneration used to invalidate the
// old codes FIRST and insert the new ones second, so a failure between the two
// statements left the user with no usable codes at all. The new set is inserted
// first and only then are the previously-unused codes retired.

import { generateBackupCodes } from '@/lib/utils/backup-codes'

export async function issueBackupCodes(service: any, userId: string): Promise<string[]> {
  const { data: previous, error: prevErr } = await service
    .from('user_mfa_backup_codes').select('id').eq('user_id', userId).is('used_at', null)
  if (prevErr) throw new Error(prevErr.message)

  const { plaintext, hashes } = generateBackupCodes()
  const { error: insertErr } = await service.from('user_mfa_backup_codes').insert(
    hashes.map((code_hash: string) => ({ user_id: userId, code_hash }))
  )
  if (insertErr) throw new Error(insertErr.message)

  const oldIds = (previous || []).map((r: { id: string }) => r.id)
  if (oldIds.length > 0) {
    const { error: retireErr } = await service
      .from('user_mfa_backup_codes').update({ used_at: new Date().toISOString() }).in('id', oldIds)
    if (retireErr) console.error('issueBackupCodes: could not retire previous codes:', retireErr.message)
  }
  return plaintext
}
