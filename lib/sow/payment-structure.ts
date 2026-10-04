// lib/sow/payment-structure.ts
//
// FIX (SOW lifecycle independent pass 11, B1): the SOW's payment structure and the project's billing model were
// never tied together. A retainer project is billed by api/cron/retainer-milestones (one 'retainer_monthly'
// milestone per month, amount = the monthly fee), but its SOW could carry ANY structure — and signing then
// created that structure's milestones (two 50% halves, a lump sum, an itemised schedule) in addition to the
// cron's monthly row, so the signing month was billed twice and the SOW text promised a split the billing never
// followed. The reverse was also possible: 'monthly' on a one-off project produced a single "Monthly retainer"
// milestone for the whole value that nothing ever repeats. One definition of what is allowed lives here.

export const SOW_PAYMENT_STRUCTURES = ['50_50', '100_upfront', 'milestones', 'monthly', 'on_delivery'] as const

/** createSowMilestones() and every renderer treat a missing structure as 50/50. */
export function storedPaymentStructure(metadata: any): string {
  const s = metadata?.paymentStructure
  return typeof s === 'string' && s ? s : '50_50'
}

export function isRetainerType(projectType: string | null | undefined): boolean {
  return projectType === 'retainer'
}

/**
 * The structure a NEW draft is generated with: a retainer is always billed monthly, so that is the only structure
 * it can have. Any other project type keeps what was requested (and `paymentStructureError` rejects 'monthly').
 */
export function structureForProject(projectType: string | null | undefined, requested: string): string {
  return isRetainerType(projectType) ? 'monthly' : requested
}

/** A message when `structure` cannot be used for this project type, otherwise null. */
export function paymentStructureError(projectType: string | null | undefined, structure: string): string | null {
  if (isRetainerType(projectType)) {
    return structure === 'monthly' ? null
      : 'This is a retainer project, which is billed monthly — but this SOW was drafted with a different payment structure. Regenerate the SOW (Regenerate from brief) so its payment terms match the monthly billing, then send it.'
  }
  return structure === 'monthly'
    ? 'Monthly billing is only available for retainer projects. Regenerate the SOW and choose another payment structure (or change the project type to retainer).'
    : null
}

/** What the generate form should send/show: retainer => monthly; anyone else can't pick monthly. */
export function effectiveFormStructure(projectType: string | null | undefined, chosen: string): string {
  if (isRetainerType(projectType)) return 'monthly'
  return chosen === 'monthly' ? '50_50' : chosen
}
