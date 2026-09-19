// Shared project-status groupings.
//
// Projects & Dashboard / Portfolio deep audit: "active" meant three different
// things — the dashboard tiles (Active + Awaiting Signature + Intake + Changes
// Requested, no Stalled), the projects tabs (Active only) and the portfolio
// rollup (dashboard's set PLUS Stalled). Everything now derives from here.

import type { ProjectStatus } from '@/lib/supabase/types'

/** Finished: no live work, no live exposure, never "needs attention". */
export const TERMINAL_PROJECT_STATUSES: readonly ProjectStatus[] = ['Complete', 'Archived']

/**
 * Work in progress — the dashboard's "In progress" / "Active contract value",
 * and the Portfolio's active-project set. Stalled is INCLUDED: a stalled
 * project still has a client, scope and contract value at stake.
 * Draft is not: nothing has been sent or agreed yet.
 */
export const IN_PROGRESS_STATUSES: readonly ProjectStatus[] =
  ['Active', 'Awaiting Signature', 'Intake', 'Changes Requested', 'Stalled']

/**
 * Statuses that consume a plan's project allowance. Pricing sells "Active
 * projects", so finished (Complete/Archived) projects must not count — they
 * cannot be deleted, so counting them locked a Solo workspace out forever
 * after its second delivery. Drafts DO count (they are deletable, which is how
 * an abandoned draft frees its slot).
 */
export const LIMIT_COUNTED_STATUSES: readonly ProjectStatus[] = ['Draft', ...IN_PROGRESS_STATUSES]

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_PROJECT_STATUSES as readonly string[]).includes(status)
}
export function isInProgressStatus(status: string): boolean {
  return (IN_PROGRESS_STATUSES as readonly string[]).includes(status)
}
