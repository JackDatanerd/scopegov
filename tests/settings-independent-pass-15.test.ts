import { describe, it, expect } from 'vitest'
import { escapeIlike, buildAuditSearchFilter } from '@/lib/audit/search'

describe('settings pass 15: audit search never treats * as a wildcard', () => {
  it('escapeIlike replaces * (PostgREST rewrites it to %) and keeps escaping % _ \\', () => {
    expect(escapeIlike('*')).toBe('_')
    expect(escapeIlike('a*b')).toBe('a_b')
    expect(escapeIlike('50%_\\')).toBe('50\\%\\_\\\\')
  })
  it('the built or() filter carries no raw * for PostgREST to expand', () => {
    const f = buildAuditSearchFilter('*')!
    expect(f).not.toContain('*')
    expect(f).toContain('%_%')
  })
})
