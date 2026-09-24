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
//   paid       = Σ amount_paid of the same invoices    (post-tax cash actually received)
//   atRisk     = Σ total of change orders sent but not yet accepted
// Retainers: base = monthly rate × term (months); a retainer-RENEWAL change order replaces the rate
// (projects.contract_value is overwritten and migration 061 records previous_contract_value), so its
// amendment must not also be added on top — historical renewal amendments still carry the full total.

import { fetchAll } from '@/lib/utils/fetch-all'

export interface ContractPosition {
  contractedValue: number
  invoicedToDate: number
  paidToDate: number
  atRiskValue: number
}

export interface PositionProject {
  id: string
  contract_value: number | null
  type?: string | null
  retainer_duration_months?: number | null
}

const CHUNK = 100 // ids per .in() — keeps the request URL well under proxy limits

/**
 * `billedMonths` is only consulted for an OPEN-ENDED retainer (no term — see api/cron/retainer-milestones): its
 * "contract" is the months committed so far (one retainer_monthly milestone each), since there is no fixed total to
 * quote. Without it the position showed a single month's fee as the whole contract while invoiced-to-date kept
 * growing past it every month.
 */
export function baseContractValue(p: PositionProject, billedMonths?: number): number {
  const v = Number(p.contract_value) || 0
  if (p.type === 'retainer') {
    if ((p.retainer_duration_months || 0) > 0) return v * (p.retainer_duration_months as number)
    return v * Math.max(1, billedMonths || 0)
  }
  return v
}

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
    const openEnded = chunk.filter(id => { const pr = byId.get(id)!; return pr.type === 'retainer' && !((pr.retainer_duration_months || 0) > 0) })
    const monthsBilled = new Map<string, number>()
    if (openEnded.length) {
      const rows = await fetchAll<any>('position retainer months', (from, to) =>
        service.from('payment_milestones').select('id, project_id')
          .in('project_id', openEnded).eq('type', 'retainer_monthly').order('id').range(from, to))
      for (const r of rows) monthsBilled.set(r.project_id, (monthsBilled.get(r.project_id) || 0) + 1)
    }

    for (const id of chunk) {
      const project = byId.get(id)!
      const isRetainer = project.type === 'retainer'
      const amendmentTotal = amendments
        .filter((a: any) => a.project_id === id)
        .filter((a: any) => !(isRetainer && a.change_orders?.is_retainer_renewal))
        .reduce((s: number, a: any) => s + (Number(a.financial_impact) || 0), 0)
      const billed = invoices.filter((inv: any) => inv.project_id === id && !['draft', 'void'].includes(inv.status))
      out.set(id, {
        contractedValue: baseContractValue(project, monthsBilled.get(id)) + amendmentTotal,
        invoicedToDate:  billed.reduce((s: number, inv: any) => s + (Number(inv.subtotal ?? inv.amount) || 0), 0),
        paidToDate:      billed.reduce((s: number, inv: any) => s + (Number(inv.amount_paid) || 0), 0),
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
