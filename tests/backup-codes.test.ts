import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import {
  generateBackupCodes, hashBackupCode, legacyBackupCodeHash, backupCodeCandidateHashes, normalizeBackupCode,
} from '@/lib/utils/backup-codes'

afterEach(() => { delete process.env.MFA_BACKUP_CODE_PEPPER; vi.restoreAllMocks() })

describe('generateBackupCodes', () => {
  it('issues 8 twelve-character dashed codes from the unambiguous alphabet, with matching hashes', () => {
    const { plaintext, hashes } = generateBackupCodes()
    expect(plaintext).toHaveLength(8)
    expect(new Set(plaintext).size).toBe(8)
    for (const c of plaintext) expect(c).toMatch(/^[2-9A-HJ-NP-Z]{6}-[2-9A-HJ-NP-Z]{6}$/)
    expect(hashes).toEqual(plaintext.map(hashBackupCode))
  })
})

describe('peppered storage', () => {
  it('is keyed: the same code hashes differently with and without the pepper', () => {
    const code = 'ABCDEF-GHJKLM'
    const plain = hashBackupCode(code)
    process.env.MFA_BACKUP_CODE_PEPPER = 'a-long-enough-server-side-pepper'
    const peppered = hashBackupCode(code)
    expect(peppered).not.toBe(plain)
    expect(peppered).toMatch(/^[0-9a-f]{64}$/)
  })
  it('ignores a pepper that is too short', () => {
    const code = 'ABCDEF-GHJKLM'
    const plain = hashBackupCode(code)
    process.env.MFA_BACKUP_CODE_PEPPER = 'short'
    expect(hashBackupCode(code)).toBe(plain)
  })
  it('is insensitive to case, spaces and the dash', () => {
    process.env.MFA_BACKUP_CODE_PEPPER = 'a-long-enough-server-side-pepper'
    const h = hashBackupCode('ABCDEF-GHJKLM')
    expect(hashBackupCode(' abcdef ghjklm ')).toBe(h)
    expect(hashBackupCode('abcdefghjklm')).toBe(h)
    expect(normalizeBackupCode('abc-def')).toBe('ABCDEF')
  })
})

describe('legacy codes keep working', () => {
  it('candidate hashes include the pre-change unsalted sha256 of the dashed code', () => {
    process.env.MFA_BACKUP_CODE_PEPPER = 'a-long-enough-server-side-pepper'
    const legacyStored = createHash('sha256').update('ABCDE-FGHJK').digest('hex') // what migration-006-era code stored
    expect(legacyBackupCodeHash('abcde-fghjk')).toBe(legacyStored)
    expect(backupCodeCandidateHashes('abcde-fghjk')).toContain(legacyStored)
  })
  it('candidate hashes include the current peppered digest', () => {
    process.env.MFA_BACKUP_CODE_PEPPER = 'a-long-enough-server-side-pepper'
    expect(backupCodeCandidateHashes('ABCDEF-GHJKLM')).toContain(hashBackupCode('ABCDEF-GHJKLM'))
  })
})
