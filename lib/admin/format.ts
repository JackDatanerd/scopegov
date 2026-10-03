// lib/admin/format.ts — pure helpers shared by the admin pages (server and client) and tests.

/** Server-rendered pages run in the server's timezone, so every timestamp there is shown as UTC and labelled. */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export const ADMIN_EVENT_TYPES = [
  'user.suspended', 'user.restored', 'user.mfa_reset', 'user.sessions_revoked', 'user.viewed', 'users.searched',
  'workspace.suspended', 'workspace.restored', 'workspace.plan_changed', 'workspace.trial_extended',
  'workspace.viewed', 'workspaces.searched', 'billing.viewed', 'finance.viewed',
] as const

/** One-line human summary of an admin audit row's metadata (the full JSON is still shown on expand). */
export function summarizeAdminMetadata(eventType: string, m: Record<string, any> | null | undefined): string {
  const md = m || {}
  const parts: string[] = []
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  switch (eventType) {
    case 'workspace.plan_changed':
      parts.push(`${s(md.previousPlan) || '?'} → ${s(md.newPlan) || '?'}`)
      if (md.trialDays) parts.push(`${md.trialDays}d trial`)
      if (md.graceCleared) parts.push('payment grace cleared')
      break
    case 'workspace.trial_extended':
      parts.push(`+${s(md.days)}d`)
      break
    case 'workspace.suspended':
      if (md.paystackCancelOk === false) parts.push('Paystack cancel FAILED')
      if (md.membersNotified != null) parts.push(`${md.membersNotified} notified`)
      break
    case 'workspace.restored':
      if (md.paystackResumeOk === false) parts.push('Paystack resume FAILED')
      if (md.paystackResumeSkipped) parts.push('subscription left as-is')
      if (md.restoredSelfDeleted) parts.push('was self-deleted')
      break
    case 'user.suspended':
      if (md.sessionsRevoked === false) parts.push('session revoke FAILED')
      break
    case 'user.restored':
      if (md.restoredSelfDeleted) parts.push('was self-deleted')
      break
    case 'user.mfa_reset':
      if (md.factorsRemoved != null) parts.push(`${md.factorsRemoved} factor(s) removed`)
      if (md.emailSent === false) parts.push('e-mail NOT sent')
      if (md.sessionsRevoked === false) parts.push('session revoke FAILED')
      break
    case 'user.sessions_revoked':
      if (md.sessionsRevoked != null) parts.push(`${md.sessionsRevoked} session(s)`)
      break
  }
  if (md.reason) parts.push(`reason: ${s(md.reason)}`)
  return parts.join(' · ')
}
