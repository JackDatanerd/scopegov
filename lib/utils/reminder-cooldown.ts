// lib/utils/reminder-cooldown.ts
//
// FIX (re-audit): none of the manual "Remind" buttons (SOW, CO, invoice)
// had any cooldown — an agency user could click Send Reminder repeatedly
// and spam the client's inbox with no rate limit at all, unlike every
// other client-facing send action in the app. This checks the audit log
// for a recent 'reminder.sent' entry against the same entity before
// allowing another one.

const DEFAULT_COOLDOWN_HOURS = 24

export async function checkReminderCooldown(
  service: any,
  entityType: string,
  entityId: string,
  cooldownHours: number = DEFAULT_COOLDOWN_HOURS
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString()

  const { data: recent } = await service
    .from('audit_log')
    .select('id, created_at')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('event_type', 'reminder.sent')
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // The reminder routes write their 'reminder.sent' claim BEFORE calling the mail provider (to
  // shrink the double-click race). If that send then fails they log 'reminder.failed'; a failure
  // newer than the claim means nothing reached the client, so it must not lock the agency out.
  if (recent) {
    const { data: failedAfter } = await service
      .from('audit_log')
      .select('id')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('event_type', 'reminder.failed')
      .gt('created_at', recent.created_at)
      .limit(1)
      .maybeSingle()
    if (failedAfter) return { allowed: true }
    return {
      allowed: false,
      message: `A reminder was already sent recently — please wait before sending another (limit: one every ${cooldownHours}h).`,
    }
  }
  return { allowed: true }
}
