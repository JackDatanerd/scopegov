import { describe, it, expect, beforeEach, vi } from 'vitest'

// email_log writes go through the service client; keep them off the network.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}))

import { sendEmail, isDeliverableAddress, __setResendForTests } from '@/lib/email/send'
import { checkedSend } from '@/lib/email/delivery'
import { formatFrom, systemFrom, safeDisplayName, DEFAULT_FROM_ADDRESS } from '@/lib/email/from'
import { formatMoney, formatAmount } from '@/lib/utils/money'

const base = { from: '"A via ScopeGov" <noreply@x.test>', subject: 's', html: '<p>x</p>' }
function fakeResend(impl: (body: any) => Promise<any>) {
  const calls: any[] = []
  __setResendForTests({ emails: { send: async (b: any) => { calls.push(b); return impl(b) } } } as any)
  return calls
}

describe('sendEmail — Resend reports failure by RESOLVING { error }', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

  it('a resolved provider error is a failed send, not a success', async () => {
    fakeResend(async () => ({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' } }))
    const r = await sendEmail({ ...base, to: 'c@example.com' })
    expect(r).toEqual({ ok: false, error: 'Invalid `from` field.' })
  })

  it('a thrown failure (e.g. missing API key) is also a failed send and never propagates', async () => {
    fakeResend(async () => { throw new Error('Missing API key') })
    const r = await sendEmail({ ...base, to: 'c@example.com' })
    expect(r).toEqual({ ok: false, error: 'Missing API key' })
  })

  it('returns the provider id on success', async () => {
    fakeResend(async () => ({ data: { id: 'em_1' }, error: null }))
    expect(await sendEmail({ ...base, to: 'c@example.com' })).toEqual({ ok: true, id: 'em_1' })
  })

  it('drops a malformed CC instead of letting it sink the whole message, and never CCs the To address', async () => {
    const calls = fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    await sendEmail({ ...base, to: 'c@example.com', cc: ['not-an-email', 'C@example.com', 'ok@example.com', 'ok@example.com'] })
    expect(calls[0].cc).toEqual(['ok@example.com'])
  })

  it('omits cc entirely when nothing valid is left', async () => {
    const calls = fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    await sendEmail({ ...base, to: 'c@example.com', cc: ['nope'] })
    expect('cc' in calls[0]).toBe(false)
  })

  it('skips (ok) a list that only contains anonymised accounts — no bounce to a domain we do not own', async () => {
    const calls = fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    const r = await sendEmail({ ...base, to: ['u1@deleted.scopegov.app'] })
    expect(r).toEqual({ ok: true, id: null, skipped: true })
    expect(calls).toHaveLength(0)
  })

  it('removes anonymised recipients from a mixed list', async () => {
    const calls = fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    await sendEmail({ ...base, to: ['u1@deleted.scopegov.app', 'real@example.com'] })
    expect(calls[0].to).toEqual(['real@example.com'])
  })

  it('an invalid single recipient is an error the caller can see', async () => {
    fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    const r = await sendEmail({ ...base, to: 'typo@@example' })
    expect(r.ok).toBe(false)
  })

  it('passes Reply-To only when it is a valid address', async () => {
    const calls = fakeResend(async () => ({ data: { id: 'x' }, error: null }))
    await sendEmail({ ...base, to: 'c@example.com', replyTo: 'billing@agency.com' })
    await sendEmail({ ...base, to: 'c@example.com', replyTo: 'garbage' })
    expect(calls[0].replyTo).toBe('billing@agency.com')
    expect('replyTo' in calls[1]).toBe(false)
  })
})

describe('checkedSend understands sendEmail results', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  it('maps { ok:false } to a failed delivery and { ok:true } to success', async () => {
    expect(await checkedSend(async () => ({ ok: false, error: 'nope' }))).toEqual({ ok: false, error: 'nope' })
    expect(await checkedSend(async () => ({ ok: true, id: 'e' }))).toEqual({ ok: true })
  })
})

describe('From header', () => {
  it('quotes the display name and appends "via ScopeGov"', () => {
    expect(formatFrom('Acme Studio')).toBe(`"Acme Studio via ScopeGov" <${DEFAULT_FROM_ADDRESS}>`)
  })
  it('keeps commas and ampersands (legal inside a quoted name) — "Smith, Jones & Co" used to be malformed unquoted', () => {
    expect(formatFrom('Smith, Jones & Co')).toBe(`"Smith, Jones & Co via ScopeGov" <${DEFAULT_FROM_ADDRESS}>`)
  })
  it('cannot smuggle in a second address or break out of the quotes', () => {
    const f = formatFrom('Evil" <attacker@x.com>\r\nBcc: v@x.com')
    expect(f).not.toMatch(/[\r\n]/)
    expect(f.match(/</g)).toHaveLength(1)
    expect(f.match(/"/g)).toHaveLength(2)
  })
  it('falls back to plain ScopeGov for an empty name', () => {
    expect(formatFrom('')).toBe(`"ScopeGov" <${DEFAULT_FROM_ADDRESS}>`)
    expect(formatFrom(null)).toBe(`"ScopeGov" <${DEFAULT_FROM_ADDRESS}>`)
    expect(systemFrom('ScopeGov Ops')).toBe(`"ScopeGov Ops" <${DEFAULT_FROM_ADDRESS}>`)
  })
  it('honours RESEND_FROM_EMAIL and falls back when unset (no "<undefined>")', () => {
    const prev = process.env.RESEND_FROM_EMAIL
    process.env.RESEND_FROM_EMAIL = 'hello@mail.acme.test'
    expect(formatFrom('A')).toContain('<hello@mail.acme.test>')
    delete process.env.RESEND_FROM_EMAIL
    expect(formatFrom('A')).not.toContain('undefined')
    if (prev !== undefined) process.env.RESEND_FROM_EMAIL = prev
  })
  it('safeDisplayName strips controls and caps length', () => {
    expect(safeDisplayName('a\u0000b\nc')).toBe('a b c')
    expect(safeDisplayName('x'.repeat(500))).toHaveLength(120)
  })
})

describe('isDeliverableAddress', () => {
  it('accepts normal addresses, rejects blanks, junk and anonymised accounts', () => {
    expect(isDeliverableAddress('a@b.co')).toBe(true)
    expect(isDeliverableAddress('')).toBe(false)
    expect(isDeliverableAddress(null)).toBe(false)
    expect(isDeliverableAddress('a b@c.co')).toBe(false)
    expect(isDeliverableAddress('x@deleted.scopegov.app')).toBe(false)
  })
})

describe('money formatting', () => {
  it('always prints the currency minor units — "USD 1,234.5" was sent to clients', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('USD 1,234.50')
    expect(formatMoney(1500, 'USD')).toBe('USD 1,500.00')
    expect(formatMoney('99.9', 'EUR')).toBe('EUR 99.90')
  })
  it('respects zero-decimal currencies', () => {
    expect(formatAmount(1234, 'JPY')).toBe('1,234')
  })
  it('reduces the currency label to letters so it is safe in HTML and subjects', () => {
    expect(formatMoney(1, '<b>')).toBe('USD 1.00')
    expect(formatMoney(1, 'kes')).toBe('KES 1.00')
  })
  it('does not print NaN', () => {
    expect(formatMoney(undefined, 'USD')).toBe('USD 0.00')
    expect(formatMoney('abc', 'USD')).toBe('USD 0.00')
  })
})
