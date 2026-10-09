// lib/documents/liability-cap.ts
//
// The optional limitation-of-liability clause. The wording is fixed and owned by the app (never model-written), applied only
// when the workspace has chosen it, and frozen into the SOW at drafting. English documents only.

export type LiabilityCap = 'fees_paid'

export function normalizeLiabilityCap(value: unknown): LiabilityCap | null {
  return value === 'fees_paid' ? 'fees_paid' : null
}

export const LIABILITY_CAP_LEAD = 'Limitation of liability.'

export function liabilityCapSentence(cap: LiabilityCap): string {
  switch (cap) {
    case 'fees_paid':
      return 'To the maximum extent permitted by law, neither party is liable to the other for indirect, incidental, special or consequential damages, and the Provider\u2019s total liability arising out of or relating to this SOW will not exceed the fees paid by the Client under this SOW. Nothing in this SOW limits any liability that cannot be limited by law.'
  }
}
