// lib/documents/liability-cap.ts
//
// The optional limitation-of-liability clause. The wording is fixed and owned by the app (never model-written), applied only
// when the workspace has chosen it, and frozen into the SOW at drafting. English documents only.

export type LiabilityCap = 'fees_paid'

export function normalizeLiabilityCap(value: unknown): LiabilityCap | null {
  return value === 'fees_paid' ? 'fees_paid' : null
}

/**
 * `retainer`: a retainer has no end date or total, so "fees paid under this SOW" would grow with every month it runs and the cap
 * would have no ceiling anyone could price. For a retainer the cap is the fees paid in the twelve months before the event that gave
 * rise to the claim, the usual measure for a recurring engagement. Fixed-fee SOWs keep the plain wording.
 */
export function liabilityCapSentence(cap: LiabilityCap, opts: { retainer?: boolean } = {}): string {
  switch (cap) {
    case 'fees_paid': {
      const measure = opts.retainer
        ? 'the fees paid by the Client under this SOW in the twelve months before the event giving rise to the claim'
        : 'the fees paid by the Client under this SOW'
      return `To the maximum extent permitted by law, neither party is liable to the other for indirect, incidental, special or consequential damages, and the Provider\u2019s total liability arising out of or relating to this SOW will not exceed ${measure}. Nothing in this SOW limits any liability that cannot be limited by law.`
    }
  }
}
