import { describe, it, expect } from 'vitest'
import { isReminderDue, summarizeReminders, type ReminderEvent } from '@/lib/utils/client-reminder-schedule'

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString()
const now = new Date(day(10))

describe('summarizeReminders', () => {
  it('is empty with no events', () => {
    expect(summarizeReminders([])).toEqual({ lastAt: null, autoCount: 0 })
  })
  it('counts only automatic reminders toward the cap but uses any reminder as the spacing anchor', () => {
    const ev: ReminderEvent[] = [
      { type: 'sent', at: day(3), automatic: true },
      { type: 'sent', at: day(6), automatic: false },
    ]
    expect(summarizeReminders(ev)).toEqual({ lastAt: day(6), autoCount: 1 })
  })
  it('a failed send cancels the claim that preceded it', () => {
    const ev: ReminderEvent[] = [
      { type: 'sent', at: day(3), automatic: true },
      { type: 'sent', at: day(6), automatic: true },
      { type: 'failed', at: day(6), automatic: true },
    ]
    expect(summarizeReminders(ev)).toEqual({ lastAt: day(3), autoCount: 1 })
  })
  it('does not depend on input order', () => {
    const a: ReminderEvent = { type: 'sent', at: day(2), automatic: true }
    const b: ReminderEvent = { type: 'sent', at: day(5), automatic: true }
    expect(summarizeReminders([b, a])).toEqual(summarizeReminders([a, b]))
  })
})

describe('isReminderDue', () => {
  const none = { lastAt: null, autoCount: 0 }
  it('first reminder is due afterDays after the document was sent', () => {
    expect(isReminderDue({ now, sentAt: day(7), history: none, afterDays: 3, max: 3 })).toBe(true)
    expect(isReminderDue({ now, sentAt: day(8), history: none, afterDays: 3, max: 3 })).toBe(false)
  })
  it('later reminders are spaced from the previous one, manual or automatic', () => {
    expect(isReminderDue({ now, sentAt: day(0), history: { lastAt: day(9), autoCount: 1 }, afterDays: 3, max: 3 })).toBe(false)
    expect(isReminderDue({ now, sentAt: day(0), history: { lastAt: day(7), autoCount: 1 }, afterDays: 3, max: 3 })).toBe(true)
  })
  it('stops at the cap', () => {
    expect(isReminderDue({ now, sentAt: day(0), history: { lastAt: day(0), autoCount: 3 }, afterDays: 3, max: 3 })).toBe(false)
  })
  it('never fires for a document with no sent date', () => {
    expect(isReminderDue({ now, sentAt: null, history: none, afterDays: 1, max: 3 })).toBe(false)
  })
})
