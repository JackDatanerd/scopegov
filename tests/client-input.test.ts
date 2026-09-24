import { describe, it, expect } from 'vitest'
import { parseClientInput, normalizeBillingAddress, normalizeCcEmails, MAX_CC_EMAILS } from '@/lib/utils/client-input'

describe('parseClientInput — create', () => {
  it('normalises a valid client', () => {
    const r = parseClientInput({ name: '  Jane ', email: ' JANE@Acme.com ', companyName: '', ccEmails: 'A@x.com, a@x.com; jane@acme.com' }, 'create')
    expect(r).toEqual({ ok: true, updates: { name: 'Jane', email: 'jane@acme.com', company_name: null, cc_emails: ['a@x.com'] } })
  })
  it('rejects non-strings instead of throwing a TypeError', () => {
    expect(parseClientInput({ name: 5, email: 'a@b.co' }, 'create').ok).toBe(false)
    expect(parseClientInput({ name: 'x', email: null }, 'create').ok).toBe(false)
    expect(parseClientInput({ name: 'x', email: 'a@b.co', phone: { a: 1 } }, 'create').ok).toBe(false)
    expect(parseClientInput(null, 'create').ok).toBe(false)
  })
})

describe('parseClientInput — update', () => {
  it('refuses to blank a NOT NULL name (used to become a 500)', () => {
    expect(parseClientInput({ name: '   ' }, 'update')).toEqual({ ok: false, error: 'Name is required' })
  })
  it('treats an empty email as an error, not a silent no-op', () => {
    expect(parseClientInput({ email: '' }, 'update').ok).toBe(false)
  })
  it('validates timezone', () => {
    expect(parseClientInput({ timezone: 'Africa/Nairobi' }, 'update')).toEqual({ ok: true, updates: { timezone: 'Africa/Nairobi' } })
    expect(parseClientInput({ timezone: 'Mars/Olympus' }, 'update').ok).toBe(false)
    expect(parseClientInput({ timezone: '' }, 'update')).toEqual({ ok: true, updates: { timezone: null } })
  })
  it('drops the NEW primary from the CC list', () => {
    const r: any = parseClientInput({ email: 'new@x.com', ccEmails: ['new@x.com', 'b@x.com'] }, 'update', { currentEmail: 'old@x.com' })
    expect(r.updates.cc_emails).toEqual(['b@x.com'])
  })
  it('enforces length limits', () => {
    expect(parseClientInput({ notes: 'x'.repeat(5001) }, 'update').ok).toBe(false)
  })
})

// BEFORE: any JSON was stored; formatAddressLines() calls .trim() on each part, so one non-string
// value made every PDF / portal page / send for that client throw.
describe('normalizeBillingAddress', () => {
  it('keeps only known string fields, trimmed', () => {
    expect(normalizeBillingAddress({ line1: ' 1 Main St ', city: 'Nairobi', junk: 'x', postalCode: '' })).toEqual({ ok: true, value: { line1: '1 Main St', city: 'Nairobi' } })
  })
  it('turns an all-empty address into null', () => {
    expect(normalizeBillingAddress({ line1: '', city: '  ' })).toEqual({ ok: true, value: null })
    expect(normalizeBillingAddress(null)).toEqual({ ok: true, value: null })
  })
  it('rejects wrong shapes and non-string parts', () => {
    expect(normalizeBillingAddress('123 Main').ok).toBe(false)
    expect(normalizeBillingAddress([]).ok).toBe(false)
    expect(normalizeBillingAddress({ line1: { x: 1 } }).ok).toBe(false)
    expect(normalizeBillingAddress({ line1: 5 }).ok).toBe(false)
  })
})

describe('normalizeCcEmails', () => {
  it('caps the list', () => {
    const many = Array.from({ length: MAX_CC_EMAILS + 1 }, (_, i) => `p${i}@x.com`)
    expect(normalizeCcEmails(many).ok).toBe(false)
    expect(normalizeCcEmails(many.slice(0, MAX_CC_EMAILS)).ok).toBe(true)
  })
  it('rejects an invalid address', () => {
    expect(normalizeCcEmails(['nope']).ok).toBe(false)
  })
})
