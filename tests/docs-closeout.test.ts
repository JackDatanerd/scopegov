import { describe, it, expect } from 'vitest'
import { parseCoFields } from '@/lib/documents/co-input'
import { resolveInvoiceSowNumber } from '@/lib/documents/invoice-refs'
import { buildSowContentPrompt, type SowContentInput } from '@/lib/ai/sow-content'

describe('CO revised delivery date', () => {
  it('accepts a real date, an ISO timestamp, null and empty', () => {
    expect(parseCoFields({ revisedDeliveryDate: '2026-08-07' })).toEqual({ ok: true, fields: { revisedDeliveryDate: '2026-08-07' } })
    expect(parseCoFields({ revisedDeliveryDate: '2026-08-07T00:00:00.000Z' })).toEqual({ ok: true, fields: { revisedDeliveryDate: '2026-08-07' } })
    expect(parseCoFields({ revisedDeliveryDate: null })).toEqual({ ok: true, fields: { revisedDeliveryDate: null } })
    expect(parseCoFields({ revisedDeliveryDate: '' })).toEqual({ ok: true, fields: { revisedDeliveryDate: null } })
  })
  it('rejects impossible and malformed dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '08/07/2026', 20260807, {}]) {
      const r = parseCoFields({ revisedDeliveryDate: bad as any })
      expect(r.ok).toBe(false)
    }
  })
  it('leaves the field out when not supplied', () => {
    expect(parseCoFields({})).toEqual({ ok: true, fields: {} })
  })
})

describe('invoice SOW reference', () => {
  const svcWith = (row: any, boom = false) => ({
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => { if (boom) throw new Error('db'); return { data: row } } }) }) }) }),
  })
  it('prefers the direct SOW link', async () => {
    expect(await resolveInvoiceSowNumber(svcWith(null), { sow_documents: { document_number: 'SOW-0002' }, payment_milestones: { sow_documents: { document_number: 'SOW-0001' } } })).toBe('SOW-0002')
  })
  it('resolves a milestone invoice through its milestone (the two-signed-SOWs case)', async () => {
    expect(await resolveInvoiceSowNumber(svcWith(null), { sow_documents: null, payment_milestones: { sow_documents: { document_number: 'SOW-0002' } } })).toBe('SOW-0002')
  })
  it('resolves a change-order invoice through the amendment it recorded', async () => {
    expect(await resolveInvoiceSowNumber(svcWith({ sow_documents: { document_number: 'SOW-0003' } }), { co_id: 'c1' })).toBe('SOW-0003')
  })
  it('returns null — never throws — when nothing links or the lookup fails', async () => {
    expect(await resolveInvoiceSowNumber(svcWith(null), {})).toBeNull()
    expect(await resolveInvoiceSowNumber(svcWith(null, true), { co_id: 'c1' })).toBeNull()
  })
})

describe('SOW courts step', () => {
  const input = {
    agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'web', contractValue: 1000, currency: 'USD',
    paymentLabel: '50/50', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'State of Texas, United States', language: 'en',
  } as SowContentInput
  it('names the governing jurisdiction only, never a city or county', () => {
    const p = buildSowContentPrompt(input)
    expect(p).toContain('competent courts of the jurisdiction given under "Governing law"')
    expect(p).toContain('never a city, county, district')
  })
})
