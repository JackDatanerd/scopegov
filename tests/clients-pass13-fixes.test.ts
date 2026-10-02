import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE } from '@/lib/utils/client-input'
import { escapeLike, sameEmail } from '@/lib/utils/escape-like'
import { normalizeSearchText } from '@/lib/search/query'

describe('clients pass 13 — B1: `*` can no longer widen an email LIKE match', () => {
  it('escapeLike turns the unescapable PostgREST `*` wildcard into a single-character `_`', () => {
    expect(escapeLike('a*@x.com')).toBe('a_@x.com')
    expect(escapeLike('a**b')).toBe('a__b')
  })
  it('still escapes backslash, % and a literal underscore', () => {
    expect(escapeLike('50%')).toBe('50\\%')
    expect(escapeLike('jo_hn@x.com')).toBe('jo\\_hn@x.com')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })
  it('sameEmail is exact and case-insensitive, never a pattern', () => {
    expect(sameEmail(' Jane@Acme.com', 'jane@acme.com')).toBe(true)
    expect(sameEmail('a*@x.com', 'ab@x.com')).toBe(false)
    expect(sameEmail(null, 'a@x.com')).toBe(false)
  })
  it('the contact routes compare in code instead of using ilike', () => {
    for (const f of ['app/api/clients/[id]/contacts/route.ts', 'app/api/clients/[id]/contacts/[contactId]/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/\.ilike\(/)
      expect(src).toContain('sameEmail(')
    }
  })
  it('Guardian inbound and project creation confirm an exact match', () => {
    const inbound = readFileSync('app/api/guardian/inbound/route.ts', 'utf8')
    expect(inbound).not.toMatch(/client_contacts'\)[\s\S]{0,120}\.ilike\(/)
    expect(inbound).toContain('sameEmail(c.email, addr)')
    const projects = readFileSync('app/api/projects/route.ts', 'utf8')
    expect(projects).toContain('sameEmail(c.email, cu.email)')
  })
})

describe('clients pass 13 — B2: the merge picker does not claim "no other client" while loading', () => {
  const src = readFileSync('components/clients/ClientDangerZone.tsx', 'utf8')
  it('shows a loading state until the list has loaded, and the empty message only for a loaded empty list', () => {
    expect(src).toContain('others === null ? (')
    expect(src).toContain('Loading clients…')
    expect(src).toMatch(/others\.length === 0 \? \(/)
    expect(src).not.toMatch(/\(others \|\| \[\]\)\.length === 0 \? \(/)
  })
})

describe('clients pass 13 — B3: EMAIL_RE refuses more undeliverable shapes', () => {
  const BAD = [
    '.jane@acme.com', 'jane.@acme.com', 'jane@-acme.com', 'jane@acme-.com', 'jane@acme.c', 'jane@acme.1', 'jane@1.2.3.4',
    'jane@acme', '@x.com', 'a@', 'a@@x.com', `${'a'.repeat(65)}@x.com`,
  ]
  it.each(BAD)('rejects %s', e => { expect(EMAIL_RE.test(e)).toBe(false) })

  it('rejects the invisible characters the earlier lists missed', () => {
    for (const ch of ['\u2066', '\u2067', '\u2068', '\u2069', '\u061c', '\u180e', '\u034f', '\u115f', '\u3164', '\ufe0f', '\u0085', '\u{e0041}']) {
      expect(EMAIL_RE.test(`jane@acme.com${ch}`)).toBe(false)
      expect(EMAIL_RE.test(`ja${ch}ne@acme.com`)).toBe(false)
    }
  })
  it('keeps every ordinary address', () => {
    for (const e of [
      'a@b.co', 'jane+tag@sub.acme.co.ke', 'josé@exämple.com', "o'brien@x.com", 'first.last@x.com', 'first_last@x.io',
      'user@münchen.de', 'a*b@x.com', 'x@y-z.com', 'user@xn--mnchen-3ya.de', 'a@b.museum', 'a@b.c1', `${'a'.repeat(64)}@x.com`,
    ]) expect(EMAIL_RE.test(e)).toBe(true)
  })
  it('does not use a lookbehind (this module is bundled for the browser)', () => {
    expect(readFileSync('lib/utils/client-input.ts', 'utf8')).not.toContain('(?<')
  })
})

describe('clients pass 13 — B4: client list search folds accents like the rest of the app', () => {
  it('normalizeSearchText folds José → jose, Müller → muller', () => {
    expect(normalizeSearchText('José')).toBe('jose')
    expect(normalizeSearchText('Müller GmbH')).toContain('muller')
  })
  it('the list and the merge picker use it', () => {
    const list = readFileSync('components/clients/ClientsClient.tsx', 'utf8')
    expect(list).toContain("import { normalizeSearchText } from '@/lib/search/query'")
    expect(list).not.toMatch(/c\.name\.toLowerCase\(\)\.includes\(q\)/)
    expect(list.match(/normalizeSearchText\(search\)/g)?.length).toBe(2)
    const dz = readFileSync('components/clients/ClientDangerZone.tsx', 'utf8')
    expect(dz).toContain('normalizeSearchText(filter)')
  })
})
