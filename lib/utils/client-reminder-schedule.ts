// lib/utils/client-reminder-schedule.ts
//
// Pure scheduling rules for cron/client-reminders (kept separate so they are unit-testable without a database).
//
//  • The first reminder is due `afterDays` after the document was sent; each following one `afterDays` after the
//    previous reminder — manual or automatic. A person who just clicked "Remind" must not be nagged again the
//    same day by the cron.
//  • A reminder whose send was recorded and then FAILED does not count (the manual routes log `reminder.failed`
//    after claiming with `reminder.sent`; the cron does the same).
//  • At most `max` AUTOMATIC reminders per document, so a client who has simply gone quiet isn't emailed forever.

export interface ReminderEvent {
  type: 'sent' | 'failed'
  at: string          // ISO timestamp
  automatic: boolean
}

export interface ReminderHistory {
  lastAt: string | null
  autoCount: number
}

/** Fold a document's reminder audit rows (any order) into its effective history. */
export function summarizeReminders(events: ReminderEvent[]): ReminderHistory {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at))
  const effective: ReminderEvent[] = []
  for (const e of sorted) {
    if (e.type === 'sent') effective.push(e)
    else if (e.type === 'failed') {
      // A failure cancels the most recent claim before it.
      effective.pop()
    }
  }
  return {
    lastAt: effective.length ? effective[effective.length - 1].at : null,
    autoCount: effective.filter(e => e.automatic).length,
  }
}

export function isReminderDue(opts: {
  now: Date; sentAt: string | null; history: ReminderHistory; afterDays: number; max: number
}): boolean {
  const { now, sentAt, history, afterDays, max } = opts
  if (!sentAt) return false
  if (history.autoCount >= max) return false
  const anchor = history.lastAt ?? sentAt
  return now.getTime() - new Date(anchor).getTime() >= afterDays * 86400000
}
