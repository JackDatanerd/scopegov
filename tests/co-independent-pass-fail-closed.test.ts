import { describe, it, expect, vi } from 'vitest'
import { computeCoTotals } from '@/lib/documents/co-totals'
import { parseCoFields } from '@/lib/documents/co-input'
import { parseRenewalTerm } from '@/lib/documents/renewal-term'
import { sanitizePlainText, sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { workspaceTaxDefaults } from '@/lib/documents/tax-defaults'
import { releaseFlagFromCo, resolveFlagAsException } from '@/lib/documents/co-flag'
import { liveCoSiblingMessage } from '@/lib/documents/co-live-sibling'
import { getContractValueBefore } from '@/lib/documents/co-contract-value'

// A chainable, awaitable stand-in for a supabase-js query: every builder method returns itself and awaiting resolves
// to the next queued result.
function fake(results: Array<{ data?: any; error?: any }>) {
  const calls: string[] = []
  const q: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const r = results.shift() ?? { data: null, error: null }
        return (res: any) => res({ data: r.data ?? null, error: r.error ?? null })
      }
      return (...args: any[]) => { calls.push(`${prop}`); return q }
    },
  })
  return { service: { from: () => q }, calls }
}

describe('CO text is storable', () => {
  it('strips NUL / lone surrogates from titles, notes and line descriptions', () => {
    const t = parseCoFields({ title: 'a\u0000b\uD83D' })
    expect(t.ok && t.fields.title).toBe('ab\uFFFD')
    expect(sanitizePlainText('x\u0000y')).toBe('xy')
    expect(sanitizeRichTextOrNull('<p>a\u0000b</p>')).toBe('<p>ab</p>')
    const r = computeCoTotals([{ description: 'd\u0000e', quantity: 1, rate: 5 }], 0, false)
    expect(r.ok && r.totals.lineItems[0].description).toBe('de')
  })
  it('keeps valid emoji', () => {
    expect(sanitizePlainText('ok 😀')).toBe('ok 😀')
  })
})

describe('renewal term', () => {
  it('rejects non number/string values and treats blank text as unset', () => {
    expect(parseRenewalTerm([5]).ok).toBe(false)
    expect(parseRenewalTerm(true).ok).toBe(false)
    expect(parseRenewalTerm('   ')).toEqual({ ok: true, value: null })
    expect(parseRenewalTerm('12')).toEqual({ ok: true, value: 12 })
  })
})

describe('workspaceTaxDefaults', () => {
  it('throws in strict mode on a failed read, degrades (and logs) otherwise', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(workspaceTaxDefaults(fake([{ error: { message: 'boom' } }]).service, 'w', { strict: true })).rejects.toThrow()
    expect(await workspaceTaxDefaults(fake([{ error: { message: 'boom' } }]).service, 'w')).toEqual({ taxRate: 0, taxInclusive: false })
    expect(await workspaceTaxDefaults(fake([{ data: { default_tax_rate: 16, default_tax_inclusive: false } }]).service, 'w', { strict: true }))
      .toEqual({ taxRate: 16, taxInclusive: false })
    spy.mockRestore()
  })
})

describe('flag release / resolve', () => {
  it('retries once and reports failure instead of swallowing it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fake([{ error: { message: 'x' } }, { error: { message: 'x' } }])
    expect(await releaseFlagFromCo(f.service, { flagId: 'f', coId: 'c' })).toEqual({ released: false, failed: true })
    const g = fake([{ error: { message: 'x' } }, { data: [{ id: 'f' }] }])
    expect(await releaseFlagFromCo(g.service, { flagId: 'f', coId: 'c' })).toEqual({ released: true, failed: false })
    const h = fake([{ data: [] }])
    expect(await releaseFlagFromCo(h.service, { flagId: 'f', coId: 'c' })).toEqual({ released: false, failed: false })
    const i = fake([{ error: { message: 'x' } }, { error: { message: 'x' } }])
    expect(await resolveFlagAsException(i.service, { flagId: 'f', coId: 'c', resolvedBy: 'u', now: 'n' })).toEqual({ resolved: false, failed: true })
    spy.mockRestore()
  })
})

describe('live sibling message', () => {
  it("does not tell the user to withdraw an accepted version", async () => {
    const m = await liveCoSiblingMessage(fake([{ data: [{ id: 'x', version: 1, status: 'accepted' }] }]).service, { id: 'c', root_co_id: null })
    expect(m).toMatch(/already been accepted/)
    expect(m).not.toMatch(/Withdraw/)
    const n = await liveCoSiblingMessage(fake([{ data: [{ id: 'x', version: 1, status: 'awaiting_response' }] }]).service, { id: 'c', root_co_id: null })
    expect(n).toMatch(/Withdraw or close/)
  })
})

describe('getContractValueBefore fails closed', () => {
  it('throws when the amendments read fails instead of printing a wrong figure', async () => {
    const svc = fake([{ data: null }, { error: { message: 'boom' } }]).service // own amendment: none; others: error
    await expect(getContractValueBefore(svc, 'p', 'c', 1000, { project: { type: 'fixed' } })).rejects.toThrow(/contract value lookup failed/)
  })
  it('throws when both own-amendment reads fail', async () => {
    const svc = fake([{ error: { message: 'a' } }, { error: { message: 'b' } }]).service
    await expect(getContractValueBefore(svc, 'p', 'c', 1000, { project: { type: 'fixed' } })).rejects.toThrow()
  })
  it('still sums other amendments on success', async () => {
    const svc = fake([{ data: null }, { data: [{ financial_impact: 250, change_orders: { is_retainer_renewal: false } }] }]).service
    expect(await getContractValueBefore(svc, 'p', 'c', 1000, { project: { type: 'fixed' } })).toBe(1250)
  })
})

import { readFileSync } from 'fs'
const read = (p: string) => readFileSync(p, 'utf8')
describe('failed writes are not reported as lost races', () => {
  it('close, withdraw and the send claim check the write error', () => {
    expect(read('app/api/co/[id]/close/route.ts')).toMatch(/closeErr\) throw new Error/)
    expect(read('app/api/co/[id]/withdraw/route.ts')).toMatch(/withdrawErr\) throw new Error/)
    expect(read('lib/documents/send-co.ts')).toMatch(/if \(claimErr\) \{[\s\S]{0,200}status: 500/)
  })
  it('close, withdraw and revise release the flag through the shared helper', () => {
    for (const f of ['close', 'withdraw', 'revise'])
      expect(read(`app/api/co/[id]/${f}/route.ts`)).toMatch(/releaseFlagFromCo\(service/)
  })
  it('project lookups in create and AI draft surface a failed read as a 500', () => {
    expect(read('app/api/co/route.ts')).toMatch(/isRealLookupFailure\(projectErr\)/)
    expect(read('app/api/co/draft/route.ts')).toMatch(/isRealLookupFailure\(projectErr\)/)
    expect(read('app/api/co/route.ts')).toMatch(/workspaceTaxDefaults\(service, session\.workspaceId, \{ strict: true \}\)/)
  })
})
