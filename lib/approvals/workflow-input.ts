// lib/approvals/workflow-input.ts
//
// Request-body parsing for approval workflows, shared by POST /api/approval-workflows and
// PATCH /api/approval-workflows/[id]. Pure (no I/O) so it can be unit-tested.
//
// FIX (section-11 audit, pass 1 — B5): the two routes each hand-rolled their own step validation and
// they disagreed, each with a hole:
//   * POST read `s.approverRoleId` on every entry without checking the entry was an object — a `null`
//     entry threw a TypeError and came back as a 500.
//   * PATCH accepted `approverRoleId: ""` (typeof '' === 'string'); the RPC's NULLIF turned it into a
//     step with NEITHER approver, the table's one-approver CHECK rejected it, and the caller got an
//     opaque 500 for what is a plain 400.
//   * ids were never shape-checked, so a non-uuid string reached Postgres and failed there.
// One parser now, used by both.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_WORKFLOW_STEPS = 10

export interface ParsedStep { approverRoleId: string | null; approverUserId: string | null }

export type ParsedSteps = { ok: true; steps: ParsedStep[] } | { ok: false; error: string }

export function parseWorkflowSteps(raw: unknown): ParsedSteps {
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, error: 'At least one approval step is required' }
  if (raw.length > MAX_WORKFLOW_STEPS)
    return { ok: false, error: `An approval workflow can have at most ${MAX_WORKFLOW_STEPS} steps` }

  const steps: ParsedStep[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return { ok: false, error: 'Each step needs exactly one approver — a role or a person' }
    const roleRaw = (entry as any).approverRoleId
    const userRaw = (entry as any).approverUserId
    const role = typeof roleRaw === 'string' ? roleRaw.trim() : ''
    const user = typeof userRaw === 'string' ? userRaw.trim() : ''
    if ((roleRaw != null && typeof roleRaw !== 'string') || (userRaw != null && typeof userRaw !== 'string'))
      return { ok: false, error: 'Each step needs exactly one approver — a role or a person' }
    if ((!role && !user) || (role && user))
      return { ok: false, error: 'Each step needs exactly one approver — a role or a person' }
    if ((role && !UUID_RE.test(role)) || (user && !UUID_RE.test(user)))
      return { ok: false, error: 'One or more selected approvers are invalid' }
    steps.push({ approverRoleId: role || null, approverUserId: user || null })
  }
  return { ok: true, steps }
}

/**
 * A value threshold must be a number above zero. (A threshold of 0 compares `amount >= 0`, which
 * matches every document in that currency — a catch-all in disguise that also skipped the
 * duplicate-catch-all guard.) Blank / null means "no threshold" (a catch-all).
 */
export type ParsedThreshold = { ok: true; value: number | null } | { ok: false; error: string }

export function parseThresholdAmount(raw: unknown): ParsedThreshold {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'number' && typeof raw !== 'string')
    return { ok: false, error: 'Threshold must be a number greater than zero' }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0)
    return { ok: false, error: 'Threshold must be a number greater than zero' }
  return { ok: true, value: n }
}
