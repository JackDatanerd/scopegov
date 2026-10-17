import { describe, it, expect } from 'vitest'
import { paymentTermsDaysFromText, reconcileSowPaymentTerms } from '@/lib/documents/payment-terms'
import { briefItems, uncoveredDeliverables, uncoveredDeliverablesWarning } from '@/lib/sow/deliverable-coverage'
import { validateSowForSend } from '@/lib/sow/validate-send'

const sec = (id: string, content: string, visible = true) => ({ id, content, visible })

describe('the payment period follows the SOW text', () => {
  it('reads the canonical sentence', () => {
    expect(paymentTermsDaysFromText([sec('payment', '<p>Each invoice is due within 14 days of its invoice date.</p>')])).toBe(14)
  })
  it('reads an edited period, not the drafted one', () => {
    expect(paymentTermsDaysFromText([sec('payment', '<p>Each invoice is due within 30 days of the invoice date.</p>')])).toBe(30)
    expect(paymentTermsDaysFromText([sec('payment', '<p>Invoices are payable within 7 calendar days of invoice date.</p>')])).toBe(7)
  })
  it('does not read a business-day term as calendar days, or a hidden section at all', () => {
    expect(paymentTermsDaysFromText([sec('payment', '<p>Each invoice is due within 10 business days of its invoice date.</p>')])).toBeNull()
    expect(paymentTermsDaysFromText([sec('payment', '<p>due within 14 days of its invoice date</p>', false)])).toBeNull()
  })
  it('prefers the Payment Terms section over a line elsewhere', () => {
    expect(paymentTermsDaysFromText([sec('assumptions', '<p>due within 60 days of invoice date</p>'), sec('payment', '<p>due within 14 days of its invoice date</p>')])).toBe(14)
  })
  it('states nothing when the text states nothing', () => {
    expect(paymentTermsDaysFromText([sec('payment', '<p>Payment is due on receipt.</p>')])).toBeNull()
    expect(paymentTermsDaysFromText(null)).toBeNull()
  })
  it('reconciles the frozen value to the text, and drops it when the text is silent', () => {
    const edited = [sec('payment', '<p>Each invoice is due within 30 days of its invoice date.</p>')]
    expect(reconcileSowPaymentTerms({ paymentTermsDays: 14, lateFeeRate: 2 }, edited)).toEqual({ metadata: { paymentTermsDays: 30, lateFeeRate: 2 }, changed: true })
    expect(reconcileSowPaymentTerms({ paymentTermsDays: 30 }, edited).changed).toBe(false)
    expect(reconcileSowPaymentTerms({ paymentTermsDays: 14, lateFeeRate: 2 }, [sec('payment', '<p>On receipt.</p>')])).toEqual({ metadata: { lateFeeRate: 2 }, changed: true })
    expect(reconcileSowPaymentTerms(null, edited)).toEqual({ metadata: { paymentTermsDays: 30 }, changed: true })
  })
})

describe('deliverables brief coverage', () => {
  const brief = '6 posts/week combined (TikTok + IG Reels, client provides raw UGC footage), caption writing, trend research, hashtag strategy, monthly analytics report with traffic data'
  const row = (deliverable: string, owner = 'Provider', acceptanceCriteria = '') => ({ deliverable, acceptanceCriteria, owner, targetDate: '' })
  const base = [
    row('Short-form posts (6 per week combined across TikTok and Instagram Reels)', 'Provider', 'Six posts published each week across TikTok and Instagram Reels'),
    row('Caption writing', 'Provider', 'A caption written for each published post'),
    row('Trend research and hashtag strategy'),
    row('View-only analytics and traffic data access', 'Client', 'Client grants view-only access to the analytics and traffic data'),
  ]
  it('splits a brief on commas outside brackets', () => {
    expect(briefItems(brief)).toHaveLength(5)
  })
  it('flags the report when no Provider row covers it, even though a Client row mentions analytics and traffic data', () => {
    expect(uncoveredDeliverables(brief, base)).toEqual(['monthly analytics report with traffic data'])
  })
  it('is quiet once the row exists', () => {
    expect(uncoveredDeliverables(brief, [...base, row('Monthly analytics report with traffic data')])).toEqual([])
    expect(uncoveredDeliverablesWarning(brief, [...base, row('Monthly analytics report with traffic data')])).toBeNull()
  })
  it('does nothing without a brief', () => {
    expect(uncoveredDeliverables(undefined, base)).toEqual([])
    expect(uncoveredDeliverables('', base)).toEqual([])
  })
  it('reaches the send validation as a warning, never an error', () => {
    const r = validateSowForSend({
      sections: [{ id: 'deliverables', title: 'Deliverables', visible: true, content: '', table: base }], contractValue: 1200,
      metadata: { brief: { deliverables: brief } },
    } as any)
    expect(r.warnings.some(w => /monthly analytics report/i.test(w))).toBe(true)
    expect(r.errors.some(e => /analytics/i.test(e))).toBe(false)
  })
})

import { parseCoFields } from '@/lib/documents/co-input'
describe('change order invoice timing', () => {
  it('accepts the two timings and clears on empty', () => {
    expect((parseCoFields({ invoiceTiming: 'on_delivery' }) as any).fields.invoiceTiming).toBe('on_delivery')
    expect((parseCoFields({ invoiceTiming: 'on_acceptance' }) as any).fields.invoiceTiming).toBe('on_acceptance')
    expect((parseCoFields({ invoiceTiming: '' }) as any).fields.invoiceTiming).toBeNull()
    expect((parseCoFields({}) as any).fields.invoiceTiming).toBeUndefined()
  })
  it('rejects anything else', () => {
    expect(parseCoFields({ invoiceTiming: 'whenever' }).ok).toBe(false)
  })
})

import { toTitleCaseFor } from '@/lib/documents/title-case'
import { readPaymentTerms } from '@/lib/documents/payment-terms'

describe('round 3: other languages are not damaged', () => {
  const es = [sec('payment', '<p>Cada factura vence dentro de 30 días desde la fecha de la factura.</p>')]
  const de = [sec('payment', '<p>Jede Rechnung ist innerhalb von 14 Tagen nach Rechnungsdatum fällig.</p>')]
  const sw = [sec('payment', '<p>Kila ankara hulipwa ndani ya siku 14.</p>')]

  it('keeps the frozen period when a non-English text cannot be read', () => {
    for (const sections of [es, de, sw]) {
      const lang = sections === es ? 'es' : sections === de ? 'de' : 'sw'
      const r = reconcileSowPaymentTerms({ language: lang, paymentTermsDays: 14, lateFeeRate: 2 }, sections)
      expect(r.changed).toBe(false)
      expect(r.metadata.paymentTermsDays).toBe(14)
    }
  })
  it('keeps the frozen period when an English text has a day count the reader cannot interpret', () => {
    const odd = [sec('payment', '<p>Payment is expected 21 days after we send the bill.</p>')]
    expect(readPaymentTerms(odd)).toEqual({ days: null, unreadable: true })
    expect(reconcileSowPaymentTerms({ paymentTermsDays: 14 }, odd).changed).toBe(false)
  })
  it('reads "Net 30" and still drops the period for an English text that states none', () => {
    expect(paymentTermsDaysFromText([sec('payment', '<p>Terms: Net 30.</p>')])).toBe(30)
    expect(reconcileSowPaymentTerms({ paymentTermsDays: 14 }, [sec('payment', '<p>Payment is due on receipt.</p>')]).metadata.paymentTermsDays).toBeUndefined()
  })
  it('a readable period still wins in any language', () => {
    const r = reconcileSowPaymentTerms({ language: 'es', paymentTermsDays: 14 }, [sec('payment', '<p>Each invoice is due within 30 days of its invoice date.</p>')])
    expect(r.metadata.paymentTermsDays).toBe(30)
  })
  it('Title Case is English only', () => {
    expect(toTitleCaseFor('Monthly retainer', null)).toBe('Monthly Retainer')
    expect(toTitleCaseFor('Monthly retainer', 'en')).toBe('Monthly Retainer')
    expect(toTitleCaseFor('Pago inicial (50%)', 'es')).toBe('Pago inicial (50%)')
    expect(toTitleCaseFor('Acompte (50 %)', 'fr')).toBe('Acompte (50 %)')
    expect(toTitleCaseFor('Malipo ya awali', 'sw')).toBe('Malipo ya awali')
  })
  it('coverage ignores non-English SOWs and reads accented words whole', () => {
    const rows = [{ deliverable: 'Redacción de subtítulos', acceptanceCriteria: '', owner: 'Proveedor', targetDate: '' }]
    expect(uncoveredDeliverablesWarning('informe mensual de analítica', rows, 'es')).toBeNull()
    expect(uncoveredDeliverables('redacción de subtítulos', rows)).toEqual([])
    expect(uncoveredDeliverables('informe mensual de analítica', rows)).toEqual(['informe mensual de analítica'])
  })
})
