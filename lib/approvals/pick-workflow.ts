// lib/approvals/pick-workflow.ts
//
// Which approval workflow governs a document. Pure (no I/O) so it can be unit-tested
// without the engine's database and email dependencies; re-exported by engine.ts.

export function pickWorkflow<T extends {
  id: string; threshold_amount: number | string | null; threshold_currency: string | null
  apply_to_other_currencies?: boolean; allow_self_approval?: boolean; require_distinct_approvers?: boolean
}>(
  workflows: T[], amount: number, currency: string
): T | null {
  // Highest threshold the amount still clears wins; a NULL-threshold
  // catch-all sorts last so a tiered rule always beats a blanket one. Ties
  // fall back to id so the same workflow wins every time — a strict total
  // order (the old comparator returned 1 for both (a,b) and (b,a) when two
  // catch-alls existed, which is not a valid ordering).
  const rank = (w: T) => (w.threshold_amount == null ? -1 : Number(w.threshold_amount))
  const ordered = [...workflows].sort((a, b) => (rank(b) - rank(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // A thresholded workflow is only comparable against a document in the SAME
  // currency (see migration 023).
  const direct = ordered.find(w =>
    w.threshold_amount != null && w.threshold_currency === currency && amount >= Number(w.threshold_amount)
  )
  if (direct) return direct

  // FIX (section-11 audit, pass 2 — feature gap): a document in a currency
  // none of the thresholds is denominated in used to slip through completely
  // ungated, however large. A workflow can now opt in to gating every other
  // currency too (no conversion — every such document is gated); the most
  // senior chain (highest threshold) wins.
  const fallback = ordered.filter(w =>
    w.threshold_amount != null && w.threshold_currency !== currency && w.apply_to_other_currencies === true
  )
  // FIX (section-11 pass, finding 1): the catch-all used to be matched in the `direct` step above, so
  // when a workspace had a catch-all AND a workflow flagged "also gate other currencies", the flag never
  // took effect — a EUR document was always handled by the catch-all's (usually lighter) chain even though
  // the admin explicitly asked for the stricter one to cover every other currency. The catch-all now only
  // applies after both the same-currency thresholds and the opted-in other-currency fallback have had
  // their turn. Same-currency behaviour is unchanged (a cleared threshold still beats the catch-all).
  if (fallback.length === 0) return ordered.find(w => w.threshold_amount == null) ?? null

  // FIX (section-11 audit, re-audit — bug): "the most senior chain (highest
  // threshold) wins" was implemented by sorting every fallback candidate by
  // raw threshold_amount regardless of ITS OWN currency — comparing, say, a
  // 500,000 JPY threshold against a 5,000 USD one as if 500,000 > 5,000 meant
  // JPY was the more senior chain. It isn't; there's no conversion here (by
  // design, per the comment above) and raw numbers across two different
  // currencies aren't comparable at all. Magnitude only means something
  // between workflows that share a currency, so rank within each currency
  // group first — that's the one comparison this data can actually support —
  // then, only if more than one currency's workflow is still standing, fall
  // back to a deterministic (id-order) pick rather than pretend one
  // currency's number outranks another's.
  const bestPerCurrency = new Map<string, T>()
  for (const w of fallback) {
    const cur = w.threshold_currency as string
    const existing = bestPerCurrency.get(cur)
    if (!existing || rank(w) > rank(existing) || (rank(w) === rank(existing) && w.id < existing.id)) {
      bestPerCurrency.set(cur, w)
    }
  }
  // FIX (build-blocking regression, traced outside sections 7/8): same TS2802
  // downlevelIteration issue as sow-content.ts above — Array.from over spread.
  const finalists = Array.from(bestPerCurrency.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return finalists[0]
}

