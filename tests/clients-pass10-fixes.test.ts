import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE, hasUnstorableText, normalizeBillingAddress, normalizeCcEmails, parseClientInput } from '@/lib/utils/client-input'
import { isoDateInZone } from '@/lib/utils/timezone'

describe('clients pass 10 — B1: NUL bytes and lone surrogates are rejected, not a 500', () => {
  const NUL = String.fromCharCode(0)
  const LONE = '\ud800'
  it('hasUnstorableText flags NUL and unpaired surrogates only', () => {
    expect(hasUnstorableText(`a${NUL}b`)).toBe(true)
    expect(hasUnstorableText(`a${LONE}b`)).toBe(true)
    expect(hasUnstorableText('José 😀 Nairobi')).toBe(false)
  })
  it('EMAIL_RE rejects control characters and lone surrogates but keeps normal addresses', () => {
    expect(EMAIL_RE.test(`a@b.co${NUL}`)).toBe(false)
    expect(EMAIL_RE.test(`a${LONE}@b.co`)).toBe(false)
    expect(EMAIL_RE.test('a\u0007@b.co')).toBe(false)
    expect(EMAIL_RE.test('jane+tag@sub.acme.co.ke')).toBe(true)
    expect(EMAIL_RE.test('josé@exämple.com')).toBe(true)
  })
  it('parseClientInput rejects them in every text field with a 400-style error', () => {
    const base = { name: 'N', email: 'a@b.co' }
    expect(parseClientInput({ ...base, email: `a@b.co${NUL}` }, 'create').ok).toBe(false)
    expect(parseClientInput({ ...base, name: `N${NUL}` }, 'create').ok).toBe(false)
    for (const k of ['companyName', 'phone', 'notes', 'vatNumber', 'paymentTermsNote'])
      expect(parseClientInput({ ...base, [k]: `x${NUL}` }, 'create').ok).toBe(false)
    expect(parseClientInput({ ...base, notes: `x${LONE}` }, 'create').ok).toBe(false)
    expect(parseClientInput({ ...base, billingAddress: { city: `x${NUL}` } }, 'create').ok).toBe(false)
    expect(normalizeBillingAddress({ line1: `x${LONE}` }).ok).toBe(false)
    expect(normalizeCcEmails([`a@b.co${NUL}`]).ok).toBe(false)
  })
  it('still accepts ordinary international text', () => {
    expect(parseClientInput({ name: 'Zoë 😀', email: 'a@b.co', notes: 'Café — 東京' }, 'create').ok).toBe(true)
  })
  it('both contacts routes use the shared check for name and role', () => {
    for (const f of ['app/api/clients/[id]/contacts/route.ts', 'app/api/clients/[id]/contacts/[contactId]/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).toContain('hasUnstorableText(')
      expect(src).toMatch(/UNSTORABLE_TEXT_ERROR\('Name'\)/)
      expect(src).toMatch(/UNSTORABLE_TEXT_ERROR\('Role'\)/)
    }
  })
})

describe('clients pass 10 — B2: the bounce date uses the workspace time zone', () => {
  it('shows the workspace-zone day, not the UTC day', () => {
    const iso = '2026-09-04T22:30:00.000Z'
    expect(isoDateInZone(iso, 'Africa/Nairobi')).toBe('2026-09-05')
    expect(isoDateInZone(iso, 'UTC')).toBe('2026-09-04')
  })
  it('the card no longer slices an ISO string and the page passes the zone', () => {
    const card = readFileSync('components/clients/ClientContactCard.tsx', 'utf8')
    expect(card).not.toContain('toISOString().slice(0, 10)')
    expect(card).toContain('isoDateInZone(emailBouncedAt')
    const page = readFileSync('app/(app)/clients/[id]/page.tsx', 'utf8')
    expect(page).toContain('workspaceTimeZone={timeZone}')
  })
})
