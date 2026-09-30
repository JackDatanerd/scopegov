// lib/documents/co-contract-value.ts
//
// FIX (portal audit, section 18): both CO PDF routes (the internal
// app/api/pdf/co/[id]/route.ts and the portal-facing
// app/api/portal/co/[token]/pdf/route.ts) computed contractValueBefore as
// `project.contract_value - (accepted ? co.total : 0)`, on the assumption
// — stated explicitly in lib/pdf/renderer.tsx's doc comment — that
// `contract_value` already reflects the running total after every
// previously-accepted CO, with the one disclosed limitation being
// out-of-order historical COs.
//
// That assumption is false at its foundation, not just at the edges:
// nothing in this codebase ever increments `projects.contract_value` when
// a CO is accepted. finalize-co.ts only inserts a row into `amendments`
// (financial_impact = co.total) — `contract_value` stays at whatever it
// was set to at SOW signing (or a manual edit), forever. The
// reconciliation-rollup cron already knows this and computes the true
// current value correctly elsewhere as `contract_value + sum(amendments)`
// — see its own comment. The CO PDF routes never applied that same logic,
// so the old formula understated BOTH the "before" and "revised" value
// shown on every accepted CO's PDF, by that CO's own amount, on every
// single CO — not just a multi-CO edge case.
//
// Correct definition: contractValueBefore = base contract_value + the
// financial_impact of every OTHER amendment on this project whose
// change_order_id isn't this CO's own, restricted to ones created before
// this CO's own amendment row (so a CO accepted out of chronological order
// relative to another still reports the value as it stood at the moment
// THIS one was accepted, not a value influenced by COs that came later).
import { baseContractValue as projectBaseValue, amendmentImpact, loadRetainerMonthsBilled } from '@/lib/utils/contract-value'

// FIX (CO logic independent pass, CO-1): the comment above describes the ADDITIVE ledger correctly, but the
// starting point was still the raw projects.contract_value. For a retainer that column is the MONTHLY fee, and
// the app-wide definition of a retainer's contract (lib/utils/contract-value.ts - project page, dashboard,
// reports, invoice PDFs) is monthly rate x term, with retainer-renewal amendments excluded (a renewal overwrites
// the rate; older rows still carry the renewal's full total) and the result floored at 0. This function did none
// of that, so a $2,000/month, 12-month retainer with a $3,000 one-off CO printed "Original Contract Value 2,000 /
// Revised 5,000" on the CO PDF - and that figure is frozen into the executed copy at signing. The renewal branch
// is unchanged: there the number is the monthly rate, not a contract total.
export interface CoValueProject { type?: string | null; retainer_duration_months?: number | null }

export async function getContractValueBefore(
  service: any, projectId: string, coId: string, baseContractValue: number | null,
  // A retainer-renewal CO REPLACES the monthly rate. For one that is not yet accepted, `baseContractValue` IS the
  // current monthly rate (finalize-co overwrites contract_value on acceptance) - adding the project's other
  // amendments on top, as for an ordinary CO, printed a "Current Monthly Rate" that was not the rate at all.
  opts: { isRenewal?: boolean; project?: CoValueProject | null } = {}
): Promise<number | null> {
  if (baseContractValue == null) return null

  // previous_contract_value (migration 061) is the monthly rate a retainer-renewal CO replaced - it can
  // no longer be recomputed once projects.contract_value has been overwritten. Older deployments
  // without the column fall back to the plain select.
  let ownAmendment: any = null
  {
    const withPrev = await service
      .from('amendments').select('created_at, previous_contract_value')
      .eq('change_order_id', coId).maybeSingle()
    if (withPrev.error) {
      const plain = await service.from('amendments').select('created_at').eq('change_order_id', coId).maybeSingle()
      ownAmendment = plain.data
    } else ownAmendment = withPrev.data
  }
  if (ownAmendment?.previous_contract_value != null) return Number(ownAmendment.previous_contract_value)

  // A pending renewal has no amendment yet; its "before" is simply the current monthly rate.
  if (!ownAmendment && opts.isRenewal) return baseContractValue

  // Starting point: the project's contract as the rest of the app defines it (retainer = monthly x term).
  const projectShape = { contract_value: baseContractValue, type: opts.project?.type ?? null, retainer_duration_months: opts.project?.retainer_duration_months ?? null }
  let billedMonths: number | undefined
  if (projectShape.type === 'retainer' && !((projectShape.retainer_duration_months || 0) > 0)) {
    // Open-ended retainer: the "contract" is the months committed so far. Degrades to one month on a failed read.
    try { billedMonths = (await loadRetainerMonthsBilled(service, [{ id: projectId, ...projectShape }])).get(projectId) } catch { billedMonths = undefined }
  }
  const start = projectBaseValue(projectShape, billedMonths)

  // FIX (section-10 audit, 10-B1): a pending CO's "before" is the base plus every amendment accepted to date
  // (nothing ever increments projects.contract_value). A CO already accepted reports the value as it stood at
  // the moment ITS amendment landed, so COs accepted later don't leak into it.
  let q = service
    .from('amendments')
    .select('financial_impact, change_orders(is_retainer_renewal)')
    .eq('project_id', projectId)
    .neq('change_order_id', coId)
  if (ownAmendment) q = q.lt('created_at', ownAmendment.created_at)
  const { data: amendments } = await q

  return Math.max(0, start + amendmentImpact(amendments, projectShape.type))
}
