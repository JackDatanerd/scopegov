import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeBillingCadence, normalizeFeeAmount, normalizeTermMonths, normalizeRevisionNote, normalizeBillingSignals,
  retainerSuggestion, isBillingModelChange, resolveBriefStartDate,
} from '@/lib/sow/brief-signals'
import {
  buildSowContentPrompt, datePromptBlock, draftingRulesBlock, formatIsoDateForPrompt, dedupePaymentPeriodSentences,
  type SowContentInput,
} from '@/lib/ai/sow-content'
import { validateSowForSend } from '@/lib/sow/validate-send'

const read = (p: string) => readFileSync(p, 'utf8')

const base: SowContentInput = {
  agencyName: 'Burnett Specialists', clientName: 'DTC Skincare', projectName: 'DTC Skincare Socials', projectType: 'marketing',
  contractValue: 1200, currency: 'USD', paymentLabel: 'Billed monthly', paymentStructure: 'monthly', revisionRounds: 1,
  governingLaw: 'State of Texas', language: 'en', dateStyle: 'us',
}

describe('brief billing signals', () => {
  it('reads cadence, fee, term and revision wording defensively', () => {
    expect(normalizeBillingCadence('Monthly')).toBe('monthly')
    expect(normalizeBillingCadence('one-off')).toBe('one_off')
    expect(normalizeBillingCadence('weekly')).toBe('')
    expect(normalizeBillingCadence(null)).toBe('')
    expect(normalizeFeeAmount('1,200')).toBe(1200)
    expect(normalizeFeeAmount(0)).toBeNull()
    expect(normalizeFeeAmount(-5)).toBeNull()
    expect(normalizeTermMonths(6)).toBe(6)
    expect(normalizeTermMonths(0)).toBeNull()
    expect(normalizeTermMonths(61)).toBeNull()
    expect(normalizeTermMonths(2.5)).toBeNull()
    expect(normalizeRevisionNote('  1 caption revision \n per post ')).toBe('1 caption revision per post')
    expect(normalizeRevisionNote('x'.repeat(500)).length).toBeLessThanOrEqual(200)
    expect(normalizeBillingSignals({ billingCadence: 'monthly', feeAmount: 1200, termMonths: 0, revisionNote: 5 })).toEqual({
      billingCadence: 'monthly', feeAmount: 1200, termMonths: null, revisionNote: '',
    })
  })

  it('offers the retainer model only when the brief is monthly and the project is not already a retainer', () => {
    const monthly = { billingCadence: 'monthly' as const, feeAmount: 1200, termMonths: null }
    expect(retainerSuggestion(monthly, 'marketing')).toEqual({ termMonths: null, feeAmount: 1200 })
    expect(retainerSuggestion(monthly, 'retainer')).toBeNull()
    expect(retainerSuggestion({ ...monthly, billingCadence: 'one_off' }, 'web')).toBeNull()
    expect(retainerSuggestion({ ...monthly, billingCadence: '' }, 'web')).toBeNull()
    expect(retainerSuggestion(null, 'web')).toBeNull()
  })

  it('a billing-model change is a move into or out of retainer, nothing else', () => {
    expect(isBillingModelChange('marketing', 'retainer')).toBe(true)
    expect(isBillingModelChange('retainer', 'web')).toBe(true)
    expect(isBillingModelChange('web', 'marketing')).toBe(false)
    expect(isBillingModelChange('retainer', 'retainer')).toBe(false)
    expect(isBillingModelChange(null, 'retainer')).toBe(false)
  })
})

describe('start date from the brief', () => {
  const today = new Date(Date.UTC(2026, 9, 10)) // October 10, 2026
  it('a date with no year is the next such date on or after today, never a guessed past year', () => {
    expect(resolveBriefStartDate('November 1', today)).toBe('2026-11-01')
    expect(resolveBriefStartDate('Nov 1st', today)).toBe('2026-11-01')
    expect(resolveBriefStartDate('1 November', today)).toBe('2026-11-01')
    expect(resolveBriefStartDate('October 10', today)).toBe('2026-10-10')
    expect(resolveBriefStartDate('March 3', today)).toBe('2027-03-03')
  })
  it('keeps a year the brief actually states, and rejects nonsense', () => {
    expect(resolveBriefStartDate('November 1, 2027', today)).toBe('2027-11-01')
    expect(resolveBriefStartDate('2026-11-01', today)).toBe('2026-11-01')
    expect(resolveBriefStartDate('Feb 30', today)).toBeNull()
    expect(resolveBriefStartDate('sometime soon', today)).toBeNull()
    expect(resolveBriefStartDate('', today)).toBeNull()
    expect(resolveBriefStartDate(42, today)).toBeNull()
  })
})

describe('SOW drafting prompt: dates, spelling, placeholders, revisions', () => {
  it('formats ISO dates in the document style and rejects impossible ones', () => {
    expect(formatIsoDateForPrompt('2026-11-01', 'us')).toBe('November 1, 2026')
    expect(formatIsoDateForPrompt('2026-11-01', 'intl')).toBe('1 November 2026')
    expect(formatIsoDateForPrompt('2026-02-31', 'us')).toBeNull()
    expect(formatIsoDateForPrompt(undefined, 'us')).toBeNull()
  })

  it('tells the model today and the start date so it cannot guess a year', () => {
    const input = { ...base, today: '2026-10-10', startDate: '2026-11-01' }
    expect(datePromptBlock(input)).toContain("Today's date: October 10, 2026")
    expect(datePromptBlock(input)).toContain('Engagement start date (from the project record): November 1, 2026')
    const prompt = buildSowContentPrompt(input)
    expect(prompt).toContain('The engagement starts on November 1, 2026')
    expect(prompt).toContain('next occurrence on or after today')
    expect(datePromptBlock(base)).toBe('')
  })

  it('bans placeholders and asks for US spelling for a US agency only', () => {
    expect(draftingRulesBlock(base)).toContain('Never print "To be confirmed"')
    expect(draftingRulesBlock(base)).toContain('American English spelling')
    expect(draftingRulesBlock({ ...base, dateStyle: 'intl' })).not.toContain('American English')
    expect(draftingRulesBlock({ ...base, language: 'fr' })).not.toContain('American English')
  })

  it('carries how revisions are counted beside, never instead of, the round count', () => {
    const rules = draftingRulesBlock({ ...base, revisionNote: '1 caption revision per post' })
    expect(rules).toContain('counts revisions as: "1 caption revision per post"')
    expect(rules).toContain('never change that count')
    expect(draftingRulesBlock(base)).not.toContain('counts revisions as')
  })

  it('keeps reported results as measures, and deliverable boundaries inside the deliverable', () => {
    const rules = draftingRulesBlock(base)
    expect(rules).toContain('follower growth')
    expect(rules).toContain('Never promise or guarantee them')
    expect(rules).toContain('Do not add exclusions that are not in the out-of-scope brief')
  })
})

describe('payment period is stated once', () => {
  it('drops a restatement of the same period, keeps the first', () => {
    const html = '<p>Each invoice is payable within 14 days of its invoice date. Invoices are due 14 days of issue. Work pauses on any invoice more than 7 days overdue.</p>'
    const out = dedupePaymentPeriodSentences(html, 14)
    expect(out).toContain('payable within 14 days of its invoice date')
    expect(out).not.toContain('due 14 days of issue')
    expect(out).toContain('more than 7 days overdue')
  })
  it('drops a paragraph that only restated it, and leaves unrelated text alone', () => {
    const html = '<p>Each invoice is due within 14 days of its invoice date.</p><p>Invoices are due 14 days of issue.</p><p>Fees are USD 1,200.00.</p>'
    expect(dedupePaymentPeriodSentences(html, 14)).toBe('<p>Each invoice is due within 14 days of its invoice date.</p><p>Fees are USD 1,200.00.</p>')
    expect(dedupePaymentPeriodSentences('<p>Fees are USD 1,200.00.</p>', 14)).toBe('<p>Fees are USD 1,200.00.</p>')
    expect(dedupePaymentPeriodSentences('<p>Pay within 14 days. Pay within 14 days.</p>', null)).toBe('<p>Pay within 14 days. Pay within 14 days.</p>')
  })
})

describe('send-time placeholder warning', () => {
  const sections = (cell: string) => [
    { id: 'deliverables', title: 'Deliverables', visible: true, content: '', table: [{ deliverable: 'Posts', criteria: 'Six a week', owner: 'Provider', date: cell }] },
    { id: 'oos', visible: true, content: '<p>None</p>' },
    { id: 'payment', visible: true, content: '<p>USD 1,200.00 per month</p>' },
    { id: 'parties', visible: true, content: '<p>x</p>' }, { id: 'governing_law', visible: true, content: '<p>Texas</p>' }, { id: 'signature', visible: true, content: '<p>x</p>' },
  ]
  it('warns (does not block) when a table cell says To be confirmed', () => {
    const r = validateSowForSend({ sections: sections('To be confirmed'), metadata: { paymentStructure: 'monthly' }, contractValue: 1200, projectType: 'retainer' })
    expect(r.warnings.some(w => /placeholder wording/.test(w) && /Deliverables/.test(w))).toBe(true)
    expect(r.errors).toEqual([])
  })
  it('is silent when there is none', () => {
    const r = validateSowForSend({ sections: sections('November 1, 2026'), metadata: { paymentStructure: 'monthly' }, contractValue: 1200, projectType: 'retainer' })
    expect(r.warnings.some(w => /placeholder wording/.test(w))).toBe(false)
  })
})

describe('wiring', () => {
  it('parse-brief asks for and returns billing signals and a resolved start date', () => {
    const src = read('app/api/sow/parse-brief/route.ts')
    expect(src).toContain('normalizeBillingSignals(parsed')
    expect(src).toContain('resolveBriefStartDate(parsed?.startDate)')
    expect(src).toContain('billingCadence')
  })
  it('generate passes today, the project start date and the revision basis to the drafter', () => {
    const src = read('app/api/sow/generate/route.ts')
    expect(src).toContain('start_date,clients(')
    expect(src).toContain('today: new Date().toISOString().slice(0, 10)')
    expect(src).toContain('revisionNote: revisionNote || null')
    expect(src).toContain('dedupePaymentPeriodSentences(allContent.payment')
  })
  it('PATCH lets a project move into or out of retainer billing while every SOW is an unsent draft, and nothing else', () => {
    const src = read('app/api/projects/[id]/route.ts')
    expect(src).toContain('const billingModelChange = body.type !== undefined && isBillingModelChange(project.type, body.type)')
    expect(src).toContain('body.type !== project.type && !billingModelChange')
    expect(src).toContain("checkSowLock(service, sows, 'billing model (retainer or fixed project)'")
    expect(src).toContain("checkSowLock(service, freshSows, 'billing model (retainer or fixed project)'")
    // the old lock text for everything else is untouched
    expect(src).toContain('The client, project type and currency can no longer be changed because a SOW already exists for this project.')
  })
  it('the wizard asks about billing and the contracting party before anything is drafted, and offers the retainer instead of coercing', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect(src).toContain('How is it billed?')
    expect(src).toContain('Contracting company')
    expect(src).toContain('clientCompany: clientCompany.trim(), clientRepresentativeTitle: signerTitle.trim()')
    expect(src).toContain('Bill as a monthly retainer')
    expect(src).toContain('Same fee every month, any kind of work')
  })
  it('the generate modal offers the same switch and follows it', () => {
    const src = read('components/projects/ProjectDetail.tsx')
    expect(src).toContain('Bill as a monthly retainer')
    expect(src).toContain('effectiveFormStructure(billingType, paymentStructure)')
    expect(src).toContain('projectId: project.id, projectType: billingType')
  })
})
