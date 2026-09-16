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
export async function getContractValueBefore(
  service: any, projectId: string, coId: string, baseContractValue: number | null
): Promise<number | null> {
  if (baseContractValue == null) return null

  const { data: ownAmendment } = await service
    .from('amendments')
    .select('created_at')
    .eq('change_order_id', coId)
    .maybeSingle()

  // No amendment row for this CO — either it isn't accepted yet, or the
  // amendment insert in finalize-co.ts failed (that failure path already
  // logs its own audit entry). Either way, nothing to subtract-history for
  // yet: the value "before" this (still-pending, or unrecorded) CO is just
  // the current base.
  if (!ownAmendment) return baseContractValue

  const { data: priorAmendments } = await service
    .from('amendments')
    .select('financial_impact')
    .eq('project_id', projectId)
    .neq('change_order_id', coId)
    .lt('created_at', ownAmendment.created_at)

  const priorTotal = (priorAmendments || []).reduce(
    (sum: number, a: any) => sum + (a.financial_impact || 0), 0
  )
  return baseContractValue + priorTotal
}
