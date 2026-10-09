import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanSubject } from '@/lib/email/send'

describe('notifications & email independent pass 22', () => {
  it('B1: cleanSubject keeps ZWNJ/ZWJ (Persian, Indic, emoji sequences)', () => {
    expect(cleanSubject('می\u200Cخواهم')).toBe('می\u200Cخواهم')
    expect(cleanSubject('👨\u200D👩\u200D👧 Project')).toBe('👨\u200D👩\u200D👧 Project')
    expect(cleanSubject('क्\u200Dष')).toBe('क्\u200Dष')
  })
  it('B1: cleanSubject still strips bidi controls and other invisible format characters', () => {
    expect(cleanSubject('Inv\u202Eoice\u200B 1')).toBe('Invoice 1')
    expect(cleanSubject('a\u061Cb\u206Ac\u00ADd\uFEFFe')).toBe('abcde')
  })
  it('B2: the cancel heads-up to step approvers never goes to the person who cancelled', () => {
    const src = readFileSync('lib/approvals/engine.ts', 'utf8')
    expect(src).toMatch(/stepRecipients = stepRecipients\.filter\(r => r\.id !== request\.requested_by && r\.id !== params\.actorId\)/)
  })
})
