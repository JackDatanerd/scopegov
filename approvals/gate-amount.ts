// lib/approvals/gate-amount.ts
//
// The amount an approval workflow's threshold is compared against for a SOW or a change
// order — what the document actually COMMITS the client to, not the raw total stored on the
// row. Pure (no I/O) so it can be unit-tested.
//
// SOW: for a fixed-term retainer, projects.contract_value is the MONTHLY fee (see
// lib/utils/contract-value.ts). A $10,000/month, 24-month retainer is a $240,000 commitment,
// but gating on the raw column compared 10,000 against (say) a "SOWs over $25,000" rule and
// waved it through with no sign-off — approvers were also shown "$10,000". An open-ended
// retainer (no term) has no fixed total, so it's gated on the monthly rate, the only number
// the document states.
//
// CO: app/api/co/[id]/send deliberately gates on the CO's OWN total rather than the
// project's overall contract value, so a small addition doesn't trip a threshold sized for
// large scope changes — see that route's comment. This does not change that: it only scales
// a RETAINER-RENEWAL CO's own total by its own renewal_term_months, because for that CO type
// the total *is* the new monthly rate (CoEditor: "accepting this renewal just sets the new
// monthly rate") rather than the one-off amount the CO adds. A renewal with a fixed term
// commits the client to (new rate x term), same reasoning as the SOW case above. An
// open-ended renewal (no term) has nothing to scale by, so it gates on the new monthly rate
// alone, matching what renewalNeedsTerm/send-co.ts already treat as the no-term case.
// A credit/descope CO's total is stored negative and is never a renewal, so it isn't affected
// here — callers already take Math.abs() of what this returns.

import { baseContractValue } from '@/lib/utils/contract-value'

export function sowGateAmount(project: {
  contract_value: number | string | null
  type?: string | null
  retainer_duration_months?: number | null
}): number {
  const isFixedTermRetainer = project.type === 'retainer' && (project.retainer_duration_months || 0) > 0
  return isFixedTermRetainer ? baseContractValue(project as any) : (Number(project.contract_value) || 0)
}

export function coGateAmount(
  co: { total: number | string | null; is_retainer_renewal?: boolean | null; renewal_term_months?: number | null },
  project: { type?: string | null } | null | undefined,
): number {
  const total = Number(co.total) || 0
  const term = Number(co.renewal_term_months) || 0
  if (co.is_retainer_renewal && project?.type === 'retainer' && term > 0) return total * term
  return total
}
