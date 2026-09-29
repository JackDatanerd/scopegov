import { describe, it, expect } from 'vitest'
import { safeRedirectPath } from '../lib/utils/safe-redirect'

describe('safeRedirectPath', () => {
  it.each([
    '//evil.com', '/\\evil.com', '@evil.com/phish', 'https://evil.com', 'javascript:alert(1)',
    'evil.com', '/foo@evil.com', '/redirect://evil.com', '/a\nb', '/a\tb', '',
  ])('refuses %j', (v) => {
    expect(safeRedirectPath(v)).toBe('/dashboard')
  })

  it('falls back for null / undefined', () => {
    expect(safeRedirectPath(null)).toBe('/dashboard')
    expect(safeRedirectPath(undefined)).toBe('/dashboard')
  })

  it.each([
    '/dashboard', '/projects/abc?tab=sow', '/settings?tab=account', '/invite/tok_123',
    // FIX (Auth+MFA fresh audit): '@' and '://' are harmless in the query/hash of a
    // single-leading-slash path and used to drop legitimate deep links.
    '/clients?search=jo@agency.com', '/settings?return=https://example.com/x', '/docs#a@b',
  ])('keeps %j', (v) => {
    expect(safeRedirectPath(v)).toBe(v)
  })

  it('still refuses @ / :// inside the path itself', () => {
    expect(safeRedirectPath('/a@b/c')).toBe('/dashboard')
    expect(safeRedirectPath('/a://b')).toBe('/dashboard')
  })
})
