// lib/documents/approval-silence.ts
//
// The optional client-review clause of the SOW: HOW LONG the Client has to review a deliverable (the review window) and, separately,
// what happens if the Client stays silent. Both are the agency's choice (Settings), never the model's: the wording is fixed and
// app-owned, applied only when the workspace has chosen it, and frozen into the SOW at drafting. English documents only.
//
// Storage: workspaces.default_approval_days is the review window (business days); default_approval_silence is the consequence.
// A window with no consequence is valid ("The Client will approve or request changes ... within N business days"); a consequence
// of "deemed approved" needs a window, so it falls back to DEFAULT_APPROVAL_DAYS when none is stored.

export type ApprovalSilenceMode = 'deemed_approved' | 'work_waits'
export interface ApprovalSilence { mode: ApprovalSilenceMode | null; days: number | null }

/** Business days used when a workspace chose "deemed approved" but its window is missing or out of range. */
export const DEFAULT_APPROVAL_DAYS = 5

export function normalizeApprovalDays(value: unknown): number | null {
  const n = Number(value)
  return value !== null && value !== '' && Number.isInteger(n) && n >= 1 && n <= 30 ? n : null
}

/** The stored pair (or an SOW's frozen copy) as one rule, or null when the SOW should say nothing about client review. */
export function normalizeApprovalSilence(mode: unknown, days?: unknown): ApprovalSilence | null {
  const d = normalizeApprovalDays(days)
  if (mode === 'deemed_approved') return { mode, days: d ?? DEFAULT_APPROVAL_DAYS }
  if (mode === 'work_waits') return { mode, days: d }
  return d != null ? { mode: null, days: d } : null
}

export const APPROVAL_SILENCE_LEAD = 'Client review.'

const businessDays = (d: number) => `${d} business day${d === 1 ? '' : 's'}`

export function approvalSilenceSentence(rule: ApprovalSilence): string {
  const window = rule.days
    ? `The Client will approve or request changes to each deliverable within ${businessDays(rule.days)} of the Provider submitting it for review.`
    : ''
  const consequence = rule.mode === 'deemed_approved'
    ? 'If the Client does neither within that period, the deliverable is deemed approved and the Provider may proceed.'
    : rule.mode === 'work_waits'
      ? 'The Provider will not proceed with a deliverable that requires the Client\u2019s approval until that approval is given; delays in giving approval may delay delivery.'
      : ''
  return [window, consequence].filter(Boolean).join(' ')
}
