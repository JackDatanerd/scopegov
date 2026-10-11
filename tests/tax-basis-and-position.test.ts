import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { netOfTax, pickTaxBasis, parseStatedTax, projectTaxBases } from '@/lib/documents/tax-basis'
import { computeContractPositions } from '@/lib/reports/contract-position'
import { describeBilling } from '@/lib/sow/billing-summary'

const read = (p: string) => readFileSync(p, 'utf8')

describe('net of tax', () => {
  it('divides the tax out of an inclusive value, leaves exclusive / no-tax values alone', () => {
    expect(netOfTax(1200, { taxRate: 8.25, taxInclusive: true })).toBe(1108.55)
    expect(netOfTax(400, { taxRate: 8.25, taxInclusive: true })).toBe(369.52)
    expect(netOfTax(1200, { taxRate: 8.25, taxInclusive: false })).toBe(1200)
    expect(netOfTax(1200, { taxRate: 0, taxInclusive: true })).toBe(1200)
    expect(netOfTax(1200, null)).toBe(1200)
    expect(netOfTax(1200, undefined)).toBe(1200)
  })
})

describe('which SOW states the tax', () => {
  const signedTaxed = { status: 'signed', metadata: { taxRate: 8.25, taxInclusive: true } }
  const draftOther = { status: 'draft', metadata: { taxRate: 5, taxInclusive: false } }
  const signedSilent = { status: 'signed', metadata: {} }
  it('a signed SOW wins over a newer draft', () => {
    expect(pickTaxBasis([draftOther, signedTaxed])).toEqual({ taxRate: 8.25, taxInclusive: true })
  })
  it('falls back to a live SOW, ignores withdrawn/declined ones, and is null when none states tax', () => {
    expect(pickTaxBasis([draftOther])).toEqual({ taxRate: 5, taxInclusive: false })
    expect(pickTaxBasis([{ status: 'withdrawn', metadata: { taxRate: 9, taxInclusive: true } }])).toBeNull()
    expect(pickTaxBasis([signedSilent])).toBeNull()
    expect(pickTaxBasis([])).toBeNull()
  })
  it('a stated rate with no inclusive flag is treated as inclusive, like the workspace default', () => {
    expect(pickTaxBasis([{ status: 'signed', metadata: { taxRate: 8.25 } }])).toEqual({ taxRate: 8.25, taxInclusive: true })
  })
  it('stated tax terms are validated; blank means "use the default", 0 means no tax', () => {
    expect(parseStatedTax(undefined, undefined)).toEqual({ ok: true, value: undefined })
    expect(parseStatedTax('', true)).toEqual({ ok: true, value: undefined })
    expect(parseStatedTax(0, true)).toEqual({ ok: true, value: { taxRate: 0, taxInclusive: false } })
    expect(parseStatedTax('8.25', true)).toEqual({ ok: true, value: { taxRate: 8.25, taxInclusive: true } })
    expect(parseStatedTax(8.25, false)).toEqual({ ok: true, value: { taxRate: 8.25, taxInclusive: false } })
    expect(parseStatedTax(-1, true).ok).toBe(false)
    expect(parseStatedTax(101, true).ok).toBe(false)
    expect(parseStatedTax('abc', true).ok).toBe(false)
  })
  it('a failed read degrades to "no basis" for display paths and throws when strict', async () => {
    const bad = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
    expect((await projectTaxBases(bad, ['p1'])).size).toBe(0)
    await expect(projectTaxBases(bad, ['p1'], { strict: true })).rejects.toThrow('boom')
  })
})

// A table-aware stand-in for the pieces of supabase-js the position reads.
function fakeService(data: Record<string, any[]>) {
  return {
    from: (t: string) => {
      let rows = [...(data[t] || [])]
      const b: any = {
        select: () => b, order: () => b, range: () => b, limit: () => b, neq: () => b, lt: () => b, eq: () => b, is: () => b,
        in: (c: string, v: any[]) => { rows = rows.filter(r => v.includes(r[c])); return b },
        then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      }
      return b
    },
  }
}

describe('contract position when the fee includes tax', () => {
  // The case that printed "Remaining to invoice 460.97": a $1,200 tax-inclusive fee, one invoice of $1,200 (1,108.55 + 91.45 tax),
  // and a change order worth 369.52 net.
  const project = { id: 'p1', contract_value: 1200, type: 'marketing', retainer_duration_months: null }
  const base = {
    amendments: [{ id: 'a1', project_id: 'p1', change_order_id: 'c1', financial_impact: 369.52, change_orders: { is_retainer_renewal: false } }],
    invoices: [{ id: 'i1', project_id: 'p1', co_id: null, amount: 1200, amount_paid: 1200, subtotal: 1108.55, status: 'paid' }],
    change_orders: [],
  }
  it('counts the base net of tax, so nothing phantom is left to invoice', async () => {
    const svc = fakeService({ ...base, sow_documents: [{ project_id: 'p1', status: 'signed', created_at: '2026-10-11', metadata: { taxRate: 8.25, taxInclusive: true } }] })
    const pos = (await computeContractPositions(svc, [project as any])).get('p1')!
    expect(pos.contractedValue).toBeCloseTo(1478.07, 2)
    expect(pos.invoicedToDate).toBeCloseTo(1108.55, 2)
    expect(pos.contractedValue - pos.invoicedToDate).toBeCloseTo(369.52, 2) // only the change order remains
  })
  it('leaves the base alone when the SOW says tax is added on top, or states none', async () => {
    const excl = fakeService({ ...base, sow_documents: [{ project_id: 'p1', status: 'signed', created_at: '2026-10-11', metadata: { taxRate: 8.25, taxInclusive: false } }] })
    expect((await computeContractPositions(excl, [project as any])).get('p1')!.contractedValue).toBeCloseTo(1569.52, 2)
    const none = fakeService({ ...base, sow_documents: [] })
    expect((await computeContractPositions(none, [project as any])).get('p1')!.contractedValue).toBeCloseTo(1569.52, 2)
  })
})

describe('the amount sentence names the tax', () => {
  it('says whether tax is inside the amount or added on top', () => {
    expect(describeBilling({ monthly: true, amount: 1200, currency: 'USD', tax: { rate: 8.25, inclusive: true } }))
      .toBe('USD 1,200.00 is invoiced every month until the retainer ends. There is no fixed total. This includes 8.25% sales tax.')
    expect(describeBilling({ monthly: false, amount: 5000, currency: 'USD', tax: { rate: '8.25', inclusive: false } }))
      .toContain('Sales tax of 8.25% is added on top.')
    expect(describeBilling({ monthly: false, amount: 5000, currency: 'USD', tax: { rate: 0, inclusive: true } })).not.toContain('tax')
  })
})

describe('wiring: one tax basis for the whole engagement', () => {
  it('SOW generation takes the stated tax terms, validated, ahead of the workspace default', () => {
    const src = read('app/api/sow/generate/route.ts')
    expect(src).toContain('parseStatedTax(body.taxRate, body.taxInclusive)')
    expect(src).toContain('statedTax.value ?? await workspaceTaxDefaults(')
  })
  it('a new change order and a new invoice start from the SOW, then the workspace default', () => {
    const co = read('app/api/co/route.ts')
    expect(co).toContain('projectTaxBasis(service, projectId, { strict: true })')
    const inv = read('app/api/invoices/route.ts')
    expect(inv).toContain('const sowBasis = await projectTaxBasis(service, projectId)')
    expect(inv).toContain('!coTaxDefaults')
  })
  it('the forms are given the same basis: CO editor, billing defaults endpoint, project page', () => {
    expect(read('components/co/CoEditor.tsx')).toContain('billing-defaults?projectId=${encodeURIComponent(projId)}')
    const bd = read('app/api/workspace/billing-defaults/route.ts')
    expect(bd).toContain('projectTaxBasis(service, projectId)')
    expect(bd).toContain('canReadProject(service, session, projectId)')
    expect(read('app/(app)/projects/[id]/page.tsx')).toContain('const sowBasis = await projectTaxBasis(service, id)')
  })
  it('the wizard and the regenerate modal ask for the tax and send it', () => {
    const w = read('app/(app)/projects/new/page.tsx')
    expect(w).toContain('Sales tax')
    expect(w).toContain('taxRate: parseFloat(taxRateStr) || 0, taxInclusive,')
    const m = read('components/projects/ProjectDetail.tsx')
    expect(m).toContain('taxRate: parseFloat(taxRateStr) || 0, taxInclusive,')
    expect(m).toContain('existingSow?.metadata?.taxRate')
  })
  it('the CO "original contract value" is netted after the amendment reads, never before', () => {
    const src = read('lib/documents/co-contract-value.ts')
    expect(src.indexOf('amendmentsErr')).toBeLessThan(src.indexOf('projectTaxBasis(service, projectId)'))
  })
})
