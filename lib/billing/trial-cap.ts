// lib/billing/trial-cap.ts
//
// Migration 019's partial unique index `one_active_trial_per_creator` allows a person to be the creator (owner) of only
// ONE live, non-exempt trial workspace at a time. Any write that makes a workspace a live trial — creating one, moving
// a workspace to the trial plan, restoring a deleted/suspended trial workspace, handing one over — can trip it, and
// PostgREST reports that as a bare Postgres 23505. workspace/create, workspace/restore and workspace/transfer-ownership
// each map it to a real message; the two platform-admin routes that can do the same (change-plan -> trial, restore) did
// not and answered a generic 500 that told the admin nothing. One predicate so the call sites cannot drift apart.

export const ONE_ACTIVE_TRIAL_INDEX = 'one_active_trial_per_creator'

export function isOneActiveTrialConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined
  return !!e && e.code === '23505' && String(e.message ?? '').includes(ONE_ACTIVE_TRIAL_INDEX)
}
