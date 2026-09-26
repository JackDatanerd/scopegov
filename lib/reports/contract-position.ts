// lib/reports/contract-position.ts
//
// FIX (cron/portal audit round 2). The "Contract position" block on every client-facing invoice
// (email PDF, portal page, portal PDF, agency PDF) read the LATEST NIGHTLY SNAPSHOT written by
// cron/reconciliation-rollup. Two consequences:
//   * The PDF labels the row "Invoiced to date (incl. this invoice)", but a snapshot taken before the
//     invoice was sent can never include it — the figure was short by the invoice's own amount, and the
//     emailed PDF and a portal download a day later showed different numbers for the same invoice.
//   * For retainers, projects.contract_value is the MONTHLY rate, so "Contracted" was one month's fee
//     and "Remaining" hit zero after the first invoice.
// Both the rollup and the invoice render paths now use this one function, computed live.
//
// Definitions (kept identical to the rollup's original ones):
//   contracted = base contract value + amendments   (pre-tax — tax is never part of what was scoped)
//   invoiced   = Σ subtotal of non-draft, non-void invoices (falls back to `amount` for pre-014 rows)
//   paid       = Σ amount_paid of every non-draft invoice, VOID INCLUDED (post-tax cash actually
//                received — see the FIX note in computeContractPositions below for why void isn't
//                excluded here the way it is from `invoiced`)
//   atRisk     = Σ total of change orders sent but not yet accepted
// Retainers: base = monthly rate × term (months); a retainer-RENEWAL change order replaces the rate
// (projects.contract_value is overwritten and migration 061 records previous_contract_value), so its
// amendment must not also be added on top — historical renewal amendments still carry the full total.

import { fetchAll } from '@/lib/utils/fetch-all'
import { amendmentImpact, baseContractValue, loadRetainerMonthsBilled, type PositionProject } from '@/lib/utils/contract-value'

export { baseContractValue }
export type { PositionProject }

export interface ContractPosition {
  contractedValue: number
  invoicedToDate: number
  paidToDate: number
  atRiskValue: number
}

const CHUNK = 100 // ids per .in() — keeps the request URL well under proxy limits

export async function computeContractPositions(
  service: any, projects: PositionProject[],
): Promise<Map<string, ContractPosition>> {
  const out = new Map<string, ContractPosition>()
  const byId = new Map(projects.map(p => [p.id, p]))
  const ids = projects.map(p => p.id)

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const [amendments, invoices, openCos] = await Promise.all([
      fetchAll<any>('position amendments', (from, to) =>
        service.from('amendments').select('id, project_id, financial_impact, change_orders(is_retainer_renewal)')
          .in('project_id', chunk).order('id').range(from, to)),
      fetchAll<any>('position invoices', (from, to) =>
        service.from('invoices').select('id, project_id, amount, amount_paid, subtotal, status')
          .in('project_id', chunk).order('id').range(from, to)),
      fetchAll<any>('position open COs', (from, to) =>
        service.from('change_orders').select('id, project_id, total')
          .in('project_id', chunk).in('status', ['awaiting_response', 'stalled', 'countered', 'awaiting_countersignature'])
          .order('id').range(from, to)),
    ])

    // Open-ended retainers (no term): their contracted value is the months committed so far.
    const monthsBilled = await loadRetainerMonthsBilled(service, chunk.map(id => byId.get(id)!))

    for (const id of chunk) {
      const project = byId.get(id)!
      const amendmentTotal = amendmentImpact(amendments.filter((a: any) => a.project_id === id), project.type)
      const billed = invoices.filter((inv: any) => inv.project_id === id && !['draft', 'void'].includes(inv.status))
      // FIX (section-12 audit — bug): paid-to-date was summed off the same
      // `billed` set as invoiced-to-date (draft AND void excluded), reusing one
      // filter for two quantities that don't share the same correctness
      // requirement. Excluding void from INVOICED is right — a voided invoice
      // isn't live billing. But app/api/invoices/[id]/void/route.ts deliberately
      // keeps a voided invoice's payment rows on file — it won't even let you
      // void a part-paid invoice without acknowledging money was already
      // received — specifically so that fact isn't lost. Reusing `billed` for
      // PAID meant that acknowledged, already-collected cash silently vanished
      // from every "money collected" number the moment its invoice was voided
      // (this cron's own snapshot, the invoices registry's "Collected" stat,
      // BillingTab's "Paid to date", every PDF's contract-position block — all
      // of them read off this one function). Paid-to-date only needs to
      // exclude DRAFT (a draft can't carry a payment in the first place —
      // payments only ever land on a sent/partially_paid/overdue/paid invoice);
      // void doesn't erase cash that already came in.
      const paidEligible = invoices.filter((inv: any) => inv.project_id === id && inv.status !== 'draft')
      out.set(id, {
        contractedValue: baseContractValue(project, monthsBilled.get(id)) + amendmentTotal,
        invoicedToDate:  billed.reduce((s: number, inv: any) => s + (Number(inv.subtotal ?? inv.amount) || 0), 0),
        paidToDate:      paidEligible.reduce((s: number, inv: any) => s + (Number(inv.amount_paid) || 0), 0),
        atRiskValue:     openCos.filter((c: any) => c.project_id === id).reduce((s: number, c: any) => s + (Number(c.total) || 0), 0),
      })
    }
  }
  return out
}

/** Live position for one project (used by the invoice render paths). Returns null if the project can't be read. */
export async function computeContractPosition(service: any, projectId: string): Promise<ContractPosition | null> {
  const { data: project, error } = await service
    .from('projects').select('id, contract_value, type, retainer_duration_months').eq('id', projectId).maybeSingle()
  if (error || !project) return null
  try {
    return (await computeContractPositions(service, [project])).get(projectId) ?? null
  } catch (e) {
    console.error('[contract-position] live computation failed:', e)
    return null
  }
}
