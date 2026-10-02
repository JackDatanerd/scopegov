import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE } from '@/lib/utils/client-input'

const read = (f: string) => readFileSync(f, 'utf8')

describe('clients pass 14 — B1: the client list sorts names alphabetically, not by UTF-16 code unit', () => {
  const src = read('components/clients/ClientsClient.tsx')
  it('uses a fixed-locale Intl.Collator for the name sort', () => {
    expect(src).toContain("new Intl.Collator('en', { sensitivity: 'base', numeric: true })")
    expect(src).toContain('NAME_COLLATOR.compare(String(a), String(b))')
    // Fixed locale, not the runtime default: the memo also runs during SSR.
    expect(src).not.toMatch(/Intl\.Collator\(undefined/)
  })
  it('the collator orders accented names with their base letters', () => {
    const c = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
    const names = ['Zed Ltd', 'Émile & Co', 'adam inc', 'Ösel', 'Client 10', 'Client 2']
    expect([...names].sort((a, b) => c.compare(a.toLowerCase(), b.toLowerCase())))
      .toEqual(['adam inc', 'Client 2', 'Client 10', 'Émile & Co', 'Ösel', 'Zed Ltd'])
    // the old comparison put every accented name after "zed"
    expect([...names].map(n => n.toLowerCase()).sort().slice(-2)).toContain('émile & co')
  })
  it('the projects and since columns still compare directly (a collator would be wrong for ISO timestamps)', () => {
    expect(src).toMatch(/: \(a < b \? -1 : a > b \? 1 : 0\)/)
  })
})

describe('clients pass 14 — B2: a client deleted mid-request is a 404, not a bare 500', () => {
  it('POST /clients/[id]/contacts maps the client_id foreign-key violation (23503) to 404', () => {
    const src = read('app/api/clients/[id]/contacts/route.ts')
    expect(src).toContain("error?.code === '23503'")
    // the mapping sits directly before the generic throw (the file has an earlier, unrelated throw in GET)
    expect(src).toMatch(/error\?\.code === '23503'\) return NextResponse\.json\([^\n]*404 \}\)\n\s*if \(error\) throw new Error\(error\.message\)/)
  })
  it('POST /projects maps a projects.client_id violation to 404 before the generic throw', () => {
    const src = read('app/api/projects/route.ts')
    expect(src).toContain("projErr?.code === '23503' && /client_id/i.test(projErr.message || '')")
    expect(src.indexOf("projErr?.code === '23503'")).toBeLessThan(src.indexOf('if (projErr) throw new Error(projErr.message)'))
  })
})

describe('clients pass 14 — B3: saved cards stay busy until router.refresh() lands', () => {
  for (const f of ['ClientContactCard', 'BillingDetailsCard']) {
    it(`${f}: closes the editor after the refresh, not before it`, () => {
      const src = read(`components/clients/${f}.tsx`)
      expect(src).toContain('useTransition')
      expect(src).toContain('closeWhenRefreshed()')
      expect(src).toContain('startRefresh(() => { router.refresh() })')
      // the old order — close the editor, then refresh — is gone from the success path
      expect(src).not.toMatch(/setEditing\(false\)\s*\n\s*router\.refresh\(\)/)
      expect(src).toContain('saving || refreshing')
    })
  }
  it('ArchiveClientButton stays disabled while the refresh is pending', () => {
    const src = read('components/clients/ArchiveClientButton.tsx')
    expect(src).toContain('useTransition')
    expect(src).toContain('disabled={loading || refreshing}')
  })
  it('ClientContactsCard disables its row actions while refreshing and closes only the saved form', () => {
    const src = read('components/clients/ClientContactsCard.tsx')
    expect(src).toContain('refreshThenClose(')
    expect(src).not.toMatch(/onDone=\{\(\) => \{[^}]*router\.refresh\(\)/)
    expect(src.match(/busyId === c\.id \|\| refreshing/g)?.length).toBe(3)
    // closing the edit form must not clobber a different contact's open form
    expect(src).toContain('setEditingId(cur => (cur === c.id ? null : cur))')
  })
})

describe('clients pass 14 — B4: an underscore is not valid in a domain name', () => {
  it.each(['a@exa_mple.com', 'a@x.co_m', 'a@_x.com', 'a@x_.com', 'a@x._com', 'a@sub.exa_mple.org'])('rejects %s', e => {
    expect(EMAIL_RE.test(e)).toBe(false)
  })
  it('still accepts an underscore in the local part, and every previously valid shape', () => {
    for (const e of ['a_b@x.com', '_a@x.com', 'jane@acme.co.ke', "o'brien@x.com", 'user+tag@sub.example.org',
      'jörg@müller.de', 'é@例え.jp', 'a@a--b.com', 'x@xn--80ak6aa92e.com']) expect(EMAIL_RE.test(e)).toBe(true)
  })
  it('is still linear-time on hostile input', () => {
    const t = Date.now()
    for (const e of ['a@' + 'a.'.repeat(120) + '!', 'a@' + 'a-'.repeat(120) + '!', 'a@' + 'a_'.repeat(120) + '!']) EMAIL_RE.test(e)
    expect(Date.now() - t).toBeLessThan(200)
  })
})
