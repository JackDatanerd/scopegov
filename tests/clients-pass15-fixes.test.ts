import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE, normalizeCcEmails, parseClientInput } from '@/lib/utils/client-input'
import { summarizeClientMoney } from '@/lib/reports/client-money'

const read = (f: string) => readFileSync(f, 'utf8')

// ── B1: a domain (or local part) carrying pasted punctuation is not an address ────────────────────────────────────
describe('clients pass 15 — B1: EMAIL_RE rejects punctuation / symbols that ride along a pasted address', () => {
  const BAD = [
    "jane@acme.com'", "'jane@acme.com'", '\u201cjane@acme.com\u201d', 'jane@acme.com\u2019', 'jane@acme.com\u2026',
    'jane@acme.com?subject=hi', 'jane@acme.com\u00bb', 'jane@acme.com*', 'jane@acme.com=', 'jane@acme.com~', 'jane@acme.com$',
    'jane@acme.com^', 'jane@acme.com`', 'jane@acme.com{', 'jane@acme.com+', 'jane@acme.com\u2022', 'jane@acme.com\u20ac',
    'jane@acme.com\u00a9', 'jane@acme.com\u2014', 'jane@ac&me.com', 'a@ex%ample.com', 'a@x.com/', 'jane@ac!me.com', 'a@x.com|',
    'a@x.com#', 'a@\u2010x.com',
    // a curly quote / ellipsis in the LOCAL part is a paste artefact too
    '\u201cjane@acme.com', 'o\u2019brien@acme.com', 'a\u2026@x.com', 'a\u00bb@x.com',
  ]
  it.each(BAD)('rejects %s', e => { expect(EMAIL_RE.test(e)).toBe(false) })

  it('still accepts every previously valid shape — ASCII atext in the local part, IDN letters, joiners, marks', () => {
    for (const e of [
      'jane@acme.com', "o'brien@acme.co.ke", 'jane+tag@acme.com', 'a@b.co', 'jörg@müller.de', 'é@例え.jp', 'a@a--b.com',
      'x@xn--80ak6aa92e.com', 'josé@exämple.com', 'jane+tag@sub.acme.co.ke', 'first_last@x.io', 'a*@x.com', 'a_b@x.com', '_a@x.com',
      'a!b#c$d%e&f/g=h?i^j`k{l|m}n~o@x.com', 'a@x\u200cy.com', 'a@col\u00b7legi.cat', 'a@b\u0301.co', 'ab@пример.рф', 'अ@डोमेन.भारत',
    ]) expect(EMAIL_RE.test(e), e).toBe(true)
  })

  it('the earlier passes’ rejections still hold', () => {
    for (const e of ['a@x..com', '.a@x.com', 'a.@x.com', 'a@-x.com', 'a@x-.com', 'a@x.c', 'a@x.1', 'a@1.2.3.4', 'a b@x.com', 'a@x.com.',
      'a@.x.com', 'jane@acme.com,', '<jane@acme.com>', 'a@x.com\u200b', 'a\u0000@x.com', 'a@exa_mple.com', 'a@x.com;b@y.com',
      '"x"@y.com', 'a@[1.2.3.4]', 'a@x\u3164.com']) expect(EMAIL_RE.test(e), e).toBe(false)
  })

  it('is still linear-time on hostile input', () => {
    const t = Date.now()
    for (const e of ['a@' + 'a.'.repeat(120) + '!', 'a@' + 'a-'.repeat(120) + '!', 'a'.repeat(5000) + '@',
      'a@' + '\u2026'.repeat(250), '\u2026'.repeat(250) + '@x.com', 'a@' + 'a.'.repeat(60) + '\u2026'.repeat(100)]) EMAIL_RE.test(e)
    expect(Date.now() - t).toBeLessThan(200)
  })

  it('reaches every caller: create, edit, CC list', () => {
    expect(parseClientInput({ name: 'A', email: 'jane@acme.com…' }, 'create').ok).toBe(false)
    expect(parseClientInput({ email: '\u201cjane@acme.com\u201d' }, 'update').ok).toBe(false)
    expect(normalizeCcEmails('ok@x.com, bad@x.com\u2026').ok).toBe(false)
    expect(normalizeCcEmails('ok@x.com, fine@y.org')).toEqual({ ok: true, value: ['ok@x.com', 'fine@y.org'] })
  })
})

// ── B3: the Money block uses one tax basis for Invoiced / Paid / Outstanding ─────────────────────────────────────
describe('clients pass 15 — B3: summarizeClientMoney', () => {
  const projects = [{ id: 'p1', currency: 'USD' }]
  const pos = (over: Partial<{ contractedValue: number; paidToDate: number; atRiskValue: number }> = {}) =>
    new Map([['p1', { contractedValue: 1000, paidToDate: 0, atRiskValue: 0, ...over }]])

  it('a fully paid taxed invoice: Invoiced (incl. tax) equals Paid and nothing is outstanding', () => {
    const m = summarizeClientMoney(projects, pos({ paidToDate: 1160 }),
      [{ project_id: 'p1', amount: 1160, amount_paid: 1160, status: 'paid' }]).get('USD')!
    expect(m.contracted).toBe(1000)        // ex. tax — unchanged
    expect(m.invoiced).toBe(1160)          // was 1000 (the pre-tax subtotal), so Paid > Invoiced
    expect(m.paid).toBe(1160)
    expect(m.outstanding).toBe(0)
    expect(m.paid).toBeLessThanOrEqual(m.invoiced)
  })

  it('Invoiced − Paid equals Outstanding for open invoices (one basis)', () => {
    const m = summarizeClientMoney(projects, pos({ paidToDate: 500 }), [
      { project_id: 'p1', amount: 1160, amount_paid: 500, status: 'partially_paid' },
    ]).get('USD')!
    expect(m.invoiced - m.paid).toBe(m.outstanding)
    expect(m.outstanding).toBe(660)
  })

  it('overdue is counted in outstanding and on its own; drafts are neither invoiced nor owed', () => {
    const m = summarizeClientMoney(projects, pos(), [
      { project_id: 'p1', amount: 100, amount_paid: 0, status: 'sent' },
      { project_id: 'p1', amount: 250, amount_paid: 50, status: 'overdue' },
      { project_id: 'p1', amount: 999, amount_paid: 0, status: 'draft' },
    ]).get('USD')!
    expect(m.invoiced).toBe(350)
    expect(m.outstanding).toBe(300)
    expect(m.overdue).toBe(200)
  })

  it('a voided invoice is not billed or owed, but cash collected on it stays in Paid (positions, unchanged)', () => {
    const m = summarizeClientMoney(projects, pos({ paidToDate: 300 }), [
      { project_id: 'p1', amount: 1000, amount_paid: 300, status: 'void' },
    ]).get('USD')!
    expect(m.invoiced).toBe(0)
    expect(m.outstanding).toBe(0)
    expect(m.paid).toBe(300)
  })

  it('currencies stay separate, and an invoice for a project the viewer cannot see is ignored', () => {
    const r = summarizeClientMoney(
      [{ id: 'p1', currency: 'USD' }, { id: 'p2', currency: 'KES' }],
      new Map([['p1', { contractedValue: 10, paidToDate: 0, atRiskValue: 0 }], ['p2', { contractedValue: 20, paidToDate: 0, atRiskValue: 5 }]]),
      [{ project_id: 'p1', amount: 11, amount_paid: 0, status: 'sent' }, { project_id: 'p2', amount: 22, amount_paid: 0, status: 'sent' },
       { project_id: 'hidden', amount: 9999, amount_paid: 0, status: 'sent' }])
    expect(r.get('USD')!.invoiced).toBe(11)
    expect(r.get('KES')).toMatchObject({ invoiced: 22, outstanding: 22, atRisk: 5 })
    expect(Array.from(r.keys()).sort()).toEqual(['KES', 'USD'])
  })

  it('sums are rounded to cents (no 0.30000000000000004)', () => {
    const m = summarizeClientMoney(projects, pos(), [
      { project_id: 'p1', amount: '0.1', amount_paid: 0, status: 'sent' }, { project_id: 'p1', amount: '0.2', amount_paid: 0, status: 'sent' },
    ]).get('USD')!
    expect(m.invoiced).toBe(0.3)
    expect(m.outstanding).toBe(0.3)
  })

  it('an overpaid open invoice never produces a negative balance', () => {
    const m = summarizeClientMoney(projects, pos(), [{ project_id: 'p1', amount: 100, amount_paid: 130, status: 'partially_paid' }]).get('USD')!
    expect(m.outstanding).toBe(0)
  })
})

describe('clients pass 15 — B3: the client page uses it and labels the basis', () => {
  const page = read('app/(app)/clients/[id]/page.tsx')
  it('builds the block from summarizeClientMoney over one non-draft invoices read', () => {
    expect(page).toContain("import { summarizeClientMoney, type ClientMoney } from '@/lib/reports/client-money'")
    expect(page).toContain('summarizeClientMoney(projectsRaw as any[], positions, billedInvoices)')
    expect(page).toContain(".neq('status', 'draft')")
    // the old inline pre-tax accumulation is gone
    expect(page).not.toContain('m.invoiced += pos.invoicedToDate')
  })
  it('keeps the failure behaviour: a failed read blanks the whole summary', () => {
    expect(page).toContain('moneyFailed = true')
    expect(page).toContain('moneyByCurrency = new Map()')
  })
  it('states the tax basis on the cards and in a caption', () => {
    expect(page).toContain("label === 'Contracted' ? ' · ex. tax' : label === 'Invoiced' ? ' · incl. tax' : ''")
    expect(page).toContain('Contracted is before tax. Invoiced, paid and outstanding include tax.')
  })
  it('the shared pre-tax computeContractPositions (invoice PDFs) is untouched', () => {
    const cp = read('lib/reports/contract-position.ts')
    expect(cp).toContain('billed.reduce((s: number, inv: any) => s + (Number(inv.subtotal ?? inv.amount) || 0), 0)')
  })
})
