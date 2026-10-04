// lib/billing/trial-audience.ts
//
// Who hears that a trial has ENDED. The 3/2/1-day warnings (cron/trial-warning) already honour each person's
// `trial_ending` notification preference (and the workspace default / lock behind it) — Settings shows that toggle as
// "Trial ending". The day-0 "Your trial has ended" email, sent by cron/payment-overdue's trial-expiry step, went to
// every billing recipient regardless, so someone who had muted trial emails still got it. It is the same event
// family, so it applies the same filter.
//
// Recipients with no known user id cannot have a preference and are kept (fail open: a lapsed-plan notice must not be
// dropped because an id was unavailable). filterByNotificationPreference itself fails open on a failed read.

import { filterByNotificationPreference } from '@/lib/utils/permissions-query'

// `T extends object` rather than `{ id?: string | null }`: that all-optional shape is a "weak type", which TypeScript
// refuses for any recipient type that simply has no `id` field — exactly the case this must accept.
export async function applyTrialEndingPreference<T extends object>(
  service: any, workspaceId: string, recipients: T[],
): Promise<T[]> {
  const idOf = (r: T): string | null => (r as { id?: string | null }).id || null
  const identified = recipients.filter(r => !!idOf(r)) as Array<T & { id: string }>
  if (identified.length === 0) return recipients
  const kept = await filterByNotificationPreference(service, workspaceId, 'trial_ending', identified)
  const keptIds = new Set(kept.map(r => r.id))
  return recipients.filter(r => { const id = idOf(r); return !id || keptIds.has(id) })
}
