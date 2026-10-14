import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { unbilledChangeOrderGross, unbilledChangeOrderValue } from '@/lib/utils/contract-value'
import { toInvoiceContractPosition } from '@/lib/reports/contract-position'
import { stripProjectNameFromTitle, scrubProjectNameAsBrand } from '@/lib/documents/co-draft-text'
import { terminationClauseHtml, disputeClauseHtml, stripPortfolioWording, applyPortfolioUse, normalizePortfolioUse, portfolioUseSentence } from '@/lib/documents/standard-clauses'
import { addBusinessDays, clientDependencyDates, normalizeClientMaterialsDays } from '@/lib/documents/client-dates'
import { findClientDateConflicts } from '@/lib/sow/date-conflicts'
import { draftingRulesBlock, approvalSilencePromptBlock } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('invoice contract position carries the change orders\u2019 own gross', () => {
  const amendments = [{ change_order_id: 'co1', financial_impact: 369.52, change_orders: { is_retainer_renewal: false } }]
  it('reports a tax-inclusive CO at exactly its total, not the net grossed up a cent high', () => {
    expect(unbilledChangeOrderValue(amendments as any, [], 'retainer')).toBe(369.52)
    expect(Math.round(369.52 * 1.0825 * 100) / 100).toBe(400.01) // what the renderer used to print
    expect(unbilledChangeOrderGross(amendments as any, [], 'retainer', [{ id: 'co1', total: 400 }])).toBe(400)
  })
  it('scales by the unbilled share when a CO is part billed, ignores billed-out and unknown COs', () => {
    const inv = [{ co_id: 'co1', subtotal: 184.76, status: 'sent' }]
    expect(unbilledChangeOrderGross(amendments as any, inv, 'retainer', [{ id: 'co1', total: 400 }])).toBe(200)
    expect(unbilledChangeOrderGross(amendments as any, [{ co_id: 'co1', subtotal: 369.52, status: 'paid' }], 'retainer', [{ id: 'co1', total: 400 }])).toBe(0)
    expect(unbilledChangeOrderGross(amendments as any, [], 'retainer', [])).toBe(0)
  })
  it('is passed through to the invoice document and preferred by the renderer', () => {
    const p = toInvoiceContractPosition({ contractedValue: 1478.07, invoicedToDate: 1108.55, paidToDate: 1200, paidToDateNet: 1108.55, hasTax: true, atRiskValue: 0, unbilledChangeOrderValue: 369.52, unbilledChangeOrderGross: 400 })
    expect(p.unbilledChangeOrders).toBe(369.52)
    expect(p.unbilledChangeOrdersGross).toBe(400)
    expect(read('lib/pdf/renderer.tsx')).toContain('unbilledChangeOrdersGross ? r2(data.contractPosition!.unbilledChangeOrdersGross)')
    expect(read('lib/reports/contract-position.ts')).toContain("'position CO totals'")
  })
})

describe('client-facing titles never carry the project name', () => {
  it('strips a leading or trailing "<project> \u2014" from a drafted invoice title', () => {
    expect(stripProjectNameFromTitle('V7 DTC Skincare \u2014 Monthly Retainer, November 2026', 'V7 DTC Skincare')).toBe('Monthly Retainer, November 2026')
    expect(stripProjectNameFromTitle('monthly retainer - V7 DTC Skincare', 'V7 DTC Skincare')).toBe('Monthly retainer')
    expect(stripProjectNameFromTitle('Wave 2 completion', 'V7 DTC Skincare')).toBe('Wave 2 completion')
    expect(stripProjectNameFromTitle('V7 DTC Skincare', 'V7 DTC Skincare')).toBe('V7 DTC Skincare')
  })
  it('the drafter is told, and a milestone keeps its own title', () => {
    expect(read('app/api/invoices/draft/route.ts')).toContain('never start or end the title with the project name')
    expect(read('app/api/invoices/draft/route.ts')).toContain('stripProjectNameFromTitle(')
    expect(read('components/invoices/BillingTab.tsx')).toContain("if (json.title && source.type !== 'milestone') setTitle(json.title)")
  })
  it('no double possessive when the project name is followed by "brand\u2019s"', () => {
    expect(scrubProjectNameAsBrand('to support V7 DTC Skincare brand\u2019s social content', 'V7 DTC Skincare')).toBe('to support the brand\u2019s social content')
    expect(scrubProjectNameAsBrand('for the V7 DTC Skincare brand.', 'V7 DTC Skincare')).toBe("for the Client's brand.")
  })
})

describe('standard clauses are fixed text', () => {
  it('termination: one wording per kind of engagement, identical every time', () => {
    const open = terminationClauseHtml({ retainer: true })
    expect(open).toBe(terminationClauseHtml({ retainer: true, retainerMonths: null }))
    expect(open).toContain('open-ended retainer')
    expect(open).toContain('end of the monthly period in which the written notice is given')
    expect(terminationClauseHtml({ retainer: true, retainerMonths: 6 })).toContain('retainer for a term of 6 months')
    const fixed = terminationClauseHtml({ retainer: false })
    expect(fixed).toContain('materially breaches')
    expect(fixed).not.toMatch(/\b\d+ days\b/)
  })
  it('dispute resolution names the governing jurisdiction and states no invented periods', () => {
    const d = disputeClauseHtml('the State of Texas, United States')
    expect(d).toContain('the competent courts of the State of Texas, United States')
    expect(d).not.toMatch(/\b\d+\s+(?:business\s+)?days\b/)
    expect(disputeClauseHtml('')).toContain('the governing jurisdiction')
  })
})

describe('portfolio use', () => {
  const v7 = '<p><strong>Client materials.</strong> Client retains all right.</p><p><strong>Portfolio use.</strong> Provider may reference the published content as work samples unless Client objects in writing.</p>'
  it('removes portfolio wording the model volunteered', () => {
    expect(stripPortfolioWording(v7)).toBe('<p><strong>Client materials.</strong> Client retains all right.</p>')
    expect(stripPortfolioWording('<p>Provider owns tools. Provider may refer to the engagement in its portfolio only with consent.</p>')).toBe('<p>Provider owns tools.</p>')
    expect(stripPortfolioWording('<ul><li>A</li><li>Provider may use the work in case studies.</li></ul>')).toBe('<ul><li>A</li></ul>')
    expect(stripPortfolioWording('<p>Nothing relevant.</p>')).toBe('<p>Nothing relevant.</p>')
  })
  it('adds only the chosen sentence', () => {
    expect(applyPortfolioUse(v7, null, 'en')).not.toMatch(/portfolio|work samples/i)
    const consent = applyPortfolioUse(v7, 'with_consent', 'en')
    expect(consent).toContain('<strong>Portfolio use.</strong> The Provider may refer to this engagement in its portfolio only with the Client\u2019s prior written consent.')
    expect((consent.match(/Portfolio use\./g) || []).length).toBe(1)
    expect(applyPortfolioUse(v7, 'unless_objects', 'en')).toContain(portfolioUseSentence('unless_objects'))
    expect(applyPortfolioUse(v7, 'with_consent', 'fr')).toBe(v7)
    expect(normalizePortfolioUse('x')).toBeNull()
  })
})

describe('client dates are set by the platform', () => {
  it('adds business days, skipping weekends', () => {
    expect(addBusinessDays('2026-11-01', 0)).toBe('2026-11-01')
    expect(addBusinessDays('2026-11-01', 3)).toBe('2026-11-04') // Sun -> Mon 2, Tue 3, Wed 4
    expect(addBusinessDays('2026-11-06', 1)).toBe('2026-11-09') // Fri -> Mon
    expect(addBusinessDays('nope', 1)).toBeNull()
  })
  it('access is the start date; materials follow the setting (blank = the start date)', () => {
    expect(clientDependencyDates('2026-11-01', 3)).toEqual({ access: '2026-11-01', materials: '2026-11-04' })
    expect(clientDependencyDates('2026-11-01', null)).toEqual({ access: '2026-11-01', materials: '2026-11-01' })
    expect(clientDependencyDates(null, 3)).toBeNull()
    expect(normalizeClientMaterialsDays('')).toBeNull()
    expect(normalizeClientMaterialsDays(0)).toBe(0)
    expect(normalizeClientMaterialsDays(31)).toBeNull()
  })
  it('the model is handed the dates and told not to choose others', () => {
    const rules = draftingRulesBlock({ language: 'en', dateStyle: 'us', startDate: '2026-11-01', today: '2026-10-14', clientDates: { access: '2026-11-01', materials: '2026-11-04' } } as any)
    expect(rules).toContain('The platform has set the Client\'s dates')
    expect(rules).toContain('November 1, 2026')
    expect(rules).toContain('November 4, 2026')
    expect(rules).toContain('Termination and Dispute Resolution are replaced by standard clauses')
    expect(rules).toContain('Never write portfolio, publicity')
  })
  it('a Client row dated outside the platform dates is reported (and drives the generation retry)', () => {
    const rows = [{ deliverable: 'Initial raw UGC footage', acceptanceCriteria: 'Client supplies footage', owner: 'Client', targetDate: 'November 6, 2026' }]
    const msgs = findClientDateConflicts(rows, '', ['2026-11-01', '2026-11-04'])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('November 1, 2026 and November 4, 2026')
    expect(findClientDateConflicts([{ ...rows[0], targetDate: 'November 4, 2026' }], '', ['2026-11-01', '2026-11-04'])).toEqual([])
    expect(findClientDateConflicts(rows, '', null)).toEqual([])
  })
})

describe('review window is stated once', () => {
  it('both prompt branches say so', () => {
    expect(approvalSilencePromptBlock({ approvalSilence: { mode: null, days: 3 } } as any)).toContain('do not repeat it in the Roles table, Assumptions or Timeline')
    expect(approvalSilencePromptBlock({ approvalSilence: null } as any)).toContain('Say it once, in the Revision Policy only')
  })
})

describe('wiring', () => {
  const g = read('app/api/sow/generate/route.ts')
  it('generation replaces Termination and Dispute (English), applies portfolio use, freezes the choices', () => {
    expect(g).toContain('allContent.termination = terminationClauseHtml(')
    expect(g).toContain('allContent.dispute = disputeClauseHtml(contentInput.governingLaw)')
    expect(g).toContain('allContent.ip = applyPortfolioUse(allContent.ip')
    expect(g).toContain('...(portfolioUse ? { portfolioUse } : {})')
    expect(g).toContain('...(contentInput.clientDates ? { clientDates: contentInput.clientDates } : {})')
    expect(g).toContain('contentInput.clientDates ? [contentInput.clientDates.access, contentInput.clientDates.materials] : null')
  })
  it('send validation compares the table with the frozen dates', () => {
    expect(read('lib/sow/validate-send.ts')).toContain('input.metadata?.clientDates')
  })
  it('has a migration and Settings fields for both options', () => {
    const sql = read('supabase/migrations/161_portfolio_use_and_client_materials.sql')
    expect(sql).toContain("IN ('with_consent', 'unless_objects')")
    expect(sql).toContain('BETWEEN 0 AND 30')
    expect(read('app/api/workspace/settings/route.ts')).toContain("defaultPortfolioUse:        'default_portfolio_use'")
    const c = read('components/settings/SettingsClient.tsx')
    expect(c).toContain('Client materials due')
    expect(c).toContain('Portfolio use')
    expect(c).toContain('Only with the client&apos;s prior written consent')
  })
  it('the CO drafter keeps named exclusion activities apart from additional work', () => {
    expect(read('app/api/co/draft/route.ts')).toContain('keep the two groups apart')
  })
})
