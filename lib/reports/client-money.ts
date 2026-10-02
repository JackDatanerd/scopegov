// lib/reports/client-money.ts
//
// FIX (independent pass 15, section 14 — B3): the Money block on a client's page mixed two tax bases. Contracted and
// Invoiced came straight from computeContractPositions(), which is deliberately PRE-tax (the invoice PDFs' "Remaining
// contract" must compare like with like — tax is never part of what was scoped), while Paid, Outstanding and Overdue are
// POST-tax (cash received, and the unpaid part of what each invoice actually says). For a client billed with tax the block
// read, for one fully settled 1,000 + 16% invoice:  Invoiced 1,000 · Paid 1,160 · Outstanding 0 — Paid larger than
// Invoiced on a client who owes nothing.
//
// The decision (shared computeContractPositions is left exactly as it is — the PDFs depend on it):
//   Contracted  = ex-tax  (what was scoped; unchanged)
//   Invoiced    = incl-tax: Σ `amount` (the invoice total the client actually received) of every non-draft, non-void invoice
//   Paid        = incl-tax (cash received; void invoices keep what was collected on them — unchanged)
//   Outstanding / Overdue = incl-tax (unchanged)
// Invoiced, Paid and Outstanding now share one basis, so  Invoiced − Paid ≈ Outstanding  holds again, and the page labels
// each card with its basis instead of leaving the reader to guess.

export interface ClientMoney {
  contracted: number; invoiced: number; paid: number; outstanding: number; overdue: number; atRisk: number
}

export interface MoneyProject { id: string; currency?: string | null }
export interface MoneyPosition { contractedValue: number; paidToDate: number; atRiskValue: number }
export interface MoneyInvoice { project_id: string; amount: number | string | null; amount_paid: number | string | null; status: string }

export const OPEN_INVOICE_STATUSES = ['sent', 'partially_paid', 'overdue'] as const
const NOT_BILLED = new Set(['draft', 'void'])

const cents = (n: number) => Math.round(n * 100) / 100

export function summarizeClientMoney(
  projects: MoneyProject[],
  positions: Map<string, MoneyPosition>,
  invoices: MoneyInvoice[],
): Map<string, ClientMoney> {
  const byCurrency = new Map<string, ClientMoney>()
  const currencyOf = new Map(projects.map(p => [p.id, p.currency || 'USD']))
  const bucket = (c: string): ClientMoney => {
    let m = byCurrency.get(c)
    if (!m) { m = { contracted: 0, invoiced: 0, paid: 0, outstanding: 0, overdue: 0, atRisk: 0 }; byCurrency.set(c, m) }
    return m
  }

  for (const p of projects) {
    const pos = positions.get(p.id); if (!pos) continue
    const m = bucket(p.currency || 'USD')
    m.contracted += pos.contractedValue; m.paid += pos.paidToDate; m.atRisk += pos.atRiskValue
  }

  for (const inv of invoices) {
    if (NOT_BILLED.has(inv.status)) continue
    const currency = currencyOf.get(inv.project_id)
    if (!currency) continue                      // not one of the projects this viewer may see
    const m = bucket(currency)
    const total = Number(inv.amount) || 0
    m.invoiced += total
    if ((OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)) {
      const owed = Math.max(0, total - (Number(inv.amount_paid) || 0))
      m.outstanding += owed
      if (inv.status === 'overdue') m.overdue += owed
    }
  }

  for (const m of byCurrency.values()) {
    m.contracted = cents(m.contracted); m.invoiced = cents(m.invoiced); m.paid = cents(m.paid)
    m.outstanding = cents(m.outstanding); m.overdue = cents(m.overdue); m.atRisk = cents(m.atRisk)
  }
  return byCurrency
}
