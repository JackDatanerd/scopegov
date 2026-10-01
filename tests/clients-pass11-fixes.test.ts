import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE, normalizeCcEmails, parseClientInput } from '@/lib/utils/client-input'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

describe('clients pass 11 — B1: the delete explanation shows whenever the client has projects on record', () => {
  const src = readFileSync('components/clients/ClientDangerZone.tsx', 'utf8')
  it('no longer requires visibleProjectCount === 0', () => {
    expect(src).toMatch(/\{canDelete && totalProjectCount > 0 && \(/)
    expect(src).not.toMatch(/totalProjectCount > 0 && visibleProjectCount === 0/)
  })
  it('still offers the Delete button only when nothing is on record', () => {
    expect(src).toMatch(/\{canDelete && totalProjectCount === 0 && \(/)
  })
})

describe('clients pass 11 — B2: a failed contact-CC read is logged, and the send still gets the client’s own CC list', () => {
  function service(result: { data: unknown; error: unknown }) {
    const chain: any = {
      select() { return chain }, eq() { return chain }, or() { return chain }, order() { return chain },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(result).then(resolve) },
    }
    return { from: () => chain }
  }
  it('returns the existing CC list and logs the error instead of failing silently', async () => {
    const logged: unknown[][] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { logged.push(a) }
    try {
      const out = await withPrimaryContactCc(service({ data: null, error: { message: 'db down' } }), 'c1', 'to@x.com', ['cc@x.com'], 'invoice')
      expect(out).toEqual(['cc@x.com'])
      expect(logged.length).toBe(1)
      expect(String(logged[0][0])).toContain('Contact CC lookup failed')
      expect(String(logged[0][1])).toContain('db down')
    } finally { console.error = orig }
  })
  it('still appends routed contacts when the read succeeds', async () => {
    const out = await withPrimaryContactCc(
      service({ data: [{ email: 'Jane@x.com', is_primary: true }, { email: 'to@x.com' }], error: null }),
      'c1', 'to@x.com', ['cc@x.com'], 'invoice')
    expect(out).toEqual(['cc@x.com', 'Jane@x.com'])
  })
})

describe('clients pass 11 — B3: EMAIL_RE rejects malformed dots and invisible characters', () => {
  it('rejects consecutive dots and a domain that starts or ends with a dot', () => {
    for (const e of ['a@x..com', 'a..b@x.com', 'a@.x.com', 'a@x.com.', 'a@x.', 'a@.com']) expect(EMAIL_RE.test(e)).toBe(false)
  })
  it('rejects zero-width / soft-hyphen / bidi / word-joiner / BOM characters', () => {
    for (const ch of ['\u200b', '\u00ad', '\u200e', '\u200f', '\u202e', '\u2060', '\ufeff']) {
      expect(EMAIL_RE.test(`a${ch}@x.com`)).toBe(false)
      expect(EMAIL_RE.test(`a@x${ch}.com`)).toBe(false)
    }
  })
  it('keeps every ordinary address', () => {
    for (const e of ['jane+tag@sub.acme.co.ke', 'josé@exämple.com', 'first.last@x.com', "o'brien@x.com", 'a@b.co'])
      expect(EMAIL_RE.test(e)).toBe(true)
  })
  it('every entry point that uses it now refuses them', () => {
    expect(parseClientInput({ name: 'N', email: 'a@x..com' }, 'create').ok).toBe(false)
    expect(parseClientInput({ email: 'a\u200b@x.com' }, 'update').ok).toBe(false)
    expect(normalizeCcEmails(['ok@x.com', 'bad@x.com.']).ok).toBe(false)
  })
})

describe('clients pass 11 — B4: the CSV filename uses the workspace zone like the Client since column', () => {
  const src = readFileSync('components/clients/ClientsClient.tsx', 'utf8')
  it('derives the date from isoDateInZone(…, timeZone), not toISOString()', () => {
    expect(src).toContain('clients-${isoDateInZone(new Date(), timeZone)}.csv')
    expect(src).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/)
  })
})
