import { describe, it, expect } from 'vitest'
import { timeAgo } from '@/lib/utils/notification-links'
import { cleanSubject } from '@/lib/email/send'

describe('notifications & email independent pass 21', () => {
  it('timeAgo year label matches the rendered (local) date', () => {
    const now = new Date(2026, 1, 15, 12).getTime()
    const created = new Date(2025, 11, 31, 18).toISOString() // local Dec 31 2025
    expect(timeAgo(created, now)).toContain('2025')
    const sameYear = new Date(2026, 0, 3, 12).toISOString()
    expect(timeAgo(sameYear, now)).not.toContain('2026')
  })
  it('cleanSubject strips bidi and zero-width characters', () => {
    expect(cleanSubject('Inv\u202Eoice\u200B 1')).toBe('Invoice 1')
  })
})
