// lib/documents/approval-silence.ts
//
// The optional "what happens if the Client does not respond" clause. Whether silence means approval or a pause is a position that
// favours one party, so it is the agency's choice (Settings), never the model's: the wording is fixed and app-owned, applied only
// when the workspace has chosen it, and frozen into the SOW at drafting. English documents only.

export type ApprovalSilenceMode = 'deemed_approved' | 'work_waits'
export interface ApprovalSilence { mode: ApprovalSilenceMode; days: number | null }

/** Business days used when a workspace chose "deemed approved" but its day count is missing or out of range. */
export const DEFAULT_APPROVAL_DAYS = 5

export function normalizeApprovalDays(value: unknown): number | null {
  const n = Number(value)
  return value !== null && value !== '' && Number.isInteger(n) && n >= 1 && n <= 30 ? n : null
}

/** The stored pair (or an SOW's frozen copy) as one rule, or null when the SOW should say nothing. */
export function normalizeApprovalSilence(mode: unknown, days?: unknown): ApprovalSilence | null {
  if (mode === 'work_waits') return { mode, days: null }
  if (mode === 'deemed_approved') return { mode, days: normalizeApprovalDays(days) ?? DEFAULT_APPROVAL_DAYS }
  return null
}

export const APPROVAL_SILENCE_LEAD = 'Client review.'

export function approvalSilenceSentence(rule: ApprovalSilence): string {
  if (rule.mode === 'deemed_approved') {
    const d = rule.days ?? DEFAULT_APPROVAL_DAYS
    return `If the Client neither approves nor requests changes to a deliverable within ${d} business day${d === 1 ? '' : 's'} of the Provider submitting it for review, the deliverable is deemed approved and the Provider may proceed.`
  }
  return 'The Provider will not proceed with a deliverable that requires the Client\u2019s approval until that approval is given; delays in giving approval may delay delivery.'
}
