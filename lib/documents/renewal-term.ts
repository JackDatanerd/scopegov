// lib/documents/renewal-term.ts
//
// FEATURE (cron/portal audit round 2). A retainer-renewal change order replaced the monthly rate but said
// nothing about how much longer the retainer runs, so a "renewed" retainer still stopped generating monthly
// milestones at its ORIGINAL end date (and the team got a "term ended" notice for a contract that had just
// been renewed). The renewal now states its term in months; accepting it extends
// projects.retainer_duration_months by that amount (lib/documents/finalize-co.ts). The extension is measured
// from the ORIGINAL term end, so the retainer stays one contiguous run of months.

export const MAX_RENEWAL_TERM_MONTHS = 120

/** null/'' -> null (not set); a whole number 1..120 -> that number; anything else -> invalid. */
export function parseRenewalTerm(value: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n < 1 || n > MAX_RENEWAL_TERM_MONTHS)
    return { ok: false, error: `Renewal term must be a whole number of months between 1 and ${MAX_RENEWAL_TERM_MONTHS}` }
  return { ok: true, value: n }
}
