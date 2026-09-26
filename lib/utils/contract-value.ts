// lib/utils/contract-value.ts
//
// ONE definition of "what is this project worth", used by every screen that shows or sums it.
//
// Before this file the number was computed five different ways:
//   * Dashboard "Active contract value", the Projects list and the client-group totals used the
//     stored projects.contract_value alone — so an accepted change order never moved them.
//   * The project page and the Portfolio scope-health used contract_value + Σ amendments, which for
//     retainers meant "one month's fee + amendments" and double-counted historical retainer-renewal
//     amendments (a renewal overwrites the rate; migration 061 stopped recording an impact for new
//     ones, but older rows still carry the full renewal total).
//   * lib/reports/contract-position.ts had the right answer (monthly rate × term, renewal amendments
//     excluded) but only the invoice PDFs used it.
//
// Definition (identical to contract-position's "contracted"):
//   base      = contract_value                                  (fixed / hourly / other types)
//             = contract_value × retainer_duration_months       (retainers with a duration set)
//   impact    = Σ amendments.financial_impact, EXCLUDING retainer-renewal amendments on retainers
//   effective = max(0, base + impact)

export interface PositionProject {
  id: string
  contract_value: number | null
  type?: string | null
  retainer_duration_months?: number | null
}

/** Anything carrying the fields the value maths needs (a full project row, or a narrower select). */
export interface ValueProject {
  id?: string
  contract_value: number | string | null
  type?: string | null
  retainer_duration_months?: number | null
}

/**
 * `billedMonths` is only consulted for an OPEN-ENDED retainer (no term — see api/cron/retainer-milestones): its
 * "contract" is the months committed so far (one retainer_monthly milestone each), since there is no fixed total
 * to quote. Without it the value would be a single month's fee while invoiced-to-date kept growing past it.
 */
export function baseContractValue(p: ValueProject, billedMonths?: number): number {
  const v = Number(p.contract_value) || 0
  if (p.type === 'retainer') {
    if ((p.retainer_duration_months || 0) > 0) return v * (p.retainer_duration_months as number)
    return v * Math.max(1, billedMonths || 0)
  }
  return v
}

/** True for a retainer with no term set (billed monthly until completed/archived). */
export function isOpenEndedRetainer(p: ValueProject): boolean {
  return p.type === 'retainer' && !((p.retainer_duration_months || 0) > 0)
}

/**
 * retainer_monthly milestone counts for the OPEN-ENDED retainers among `projects` (project id -> months).
 * Fixed-term retainers and every other type need no query. Failures degrade to "no months known" (1 month)
 * rather than breaking the page that asked.
 *
 * FIX (Projects & Dashboard / Portfolio independent pass, round 2): this used a single
 * `.limit(5000)` per 100-project chunk with no truncation check at all — unlike every other
 * "big read" in this exact neighbourhood (lib/utils/paginate.ts's fetchPaged, used specifically
 * because PostgREST silently truncates, and which THROWS on overflow rather than let a cut-off
 * read pass as complete). A chunk of long-running open-ended retainers averaging more than 50
 * billed months each (e.g. 100 projects x 50+ months) would silently undercount past that point,
 * understating "effective contract value" for those projects on both the Dashboard/Projects list
 * and the Portfolio's scope-health numbers, with no signal anything was cut off. Paged in full per
 * chunk instead; a SAFETY_CAP still exists (this function's own design explicitly degrades rather
 * than throws — it must never break the page that asked), but hitting it is logged loudly rather
 * than silently swallowed the way the old `.limit(5000)` was.
 */
const RETAINER_MONTHS_PAGE_SIZE = 1000
// Per 100-project chunk. A chunk would only hit this with an average of 500+ billed months per
// open-ended retainer in it — pathological, not a real workspace — but it's a real, logged cap
// rather than no cap at all.
const RETAINER_MONTHS_SAFETY_CAP = 50000

export async function loadRetainerMonthsBilled(service: any, projects: ValueProject[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = projects.filter(p => p.id && isOpenEndedRetainer(p)).map(p => p.id as string)
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    let offset = 0
    for (;;) {
      const { data, error } = await service.from('payment_milestones').select('id, project_id')
        .in('project_id', chunk).eq('type', 'retainer_monthly')
        .range(offset, offset + RETAINER_MONTHS_PAGE_SIZE - 1)
      if (error) { console.error('[contract-value] retainer months lookup failed:', error.message); break }
      const batch = data || []
      for (const r of batch) out.set(r.project_id, (out.get(r.project_id) || 0) + 1)
      if (batch.length < RETAINER_MONTHS_PAGE_SIZE) break
      offset += RETAINER_MONTHS_PAGE_SIZE
      if (offset >= RETAINER_MONTHS_SAFETY_CAP) {
        console.error(`[contract-value] retainer months lookup hit its safety cap (${RETAINER_MONTHS_SAFETY_CAP}) for a project chunk — counts for these projects may be undercounted`)
        break
      }
    }
  }
  return out
}

export interface AmendmentLike {
  financial_impact: number | string | null
  // PostgREST returns a to-one embed as an object; tolerate an array too.
  change_orders?: { is_retainer_renewal?: boolean | null } | Array<{ is_retainer_renewal?: boolean | null }> | null
}

function isRenewalAmendment(a: AmendmentLike): boolean {
  const co = Array.isArray(a.change_orders) ? a.change_orders[0] : a.change_orders
  return !!co?.is_retainer_renewal
}

/** Σ financial impact of a project's amendments, minus retainer-renewal ones on retainers. */
export function amendmentImpact(amendments: AmendmentLike[] | null | undefined, projectType: string | null | undefined): number {
  const isRetainer = projectType === 'retainer'
  let total = 0
  for (const a of amendments || []) {
    if (isRetainer && isRenewalAmendment(a)) continue
    total += Number(a.financial_impact) || 0
  }
  return total
}

/** Base + amendments, floored at zero. */
export function effectiveContractValue(project: ValueProject, amendments: AmendmentLike[] | null | undefined, billedMonths?: number): number {
  return Math.max(0, baseContractValue(project, billedMonths) + amendmentImpact(amendments, project.type))
}

/** The recurring monthly rate for a retainer, or null for every other project type. */
export function monthlyRetainerRate(project: { type?: string | null; contract_value: number | string | null }): number | null {
  return project.type === 'retainer' ? (Number(project.contract_value) || 0) : null
}
