// tests/trial-plan-workspace-pass-1.test.ts
//
// Trial / plan change / multiple-workspaces independent pass — the pure pieces (no module mocks, so the REAL
// filterByNotificationPreference runs against a fake client).
//   * trialBarPercent: the Sidebar's "X of 14 trial days" bar overflowed for an admin-extended trial.
//   * isOneActiveTrialConflict: the predicate the two platform-admin routes now share with the self-service ones.
//   * applyTrialEndingPreference: the day-0 "trial has ended" email now honours the `trial_ending` preference.

import { describe, it, expect, vi } from 'vitest'
import { TRIAL_DAYS, trialBarPercent } from '@/lib/billing/plans'
import { isOneActiveTrialConflict } from '@/lib/billing/trial-cap'
import { applyTrialEndingPreference } from '@/lib/billing/trial-audience'

describe('trialBarPercent', () => {
  it('a standard trial drains from full to empty', () => {
    expect(TRIAL_DAYS).toBe(14)
    expect(trialBarPercent(14)).toBe(100)
    expect(trialBarPercent(7)).toBe(50)
    expect(trialBarPercent(1)).toBe(7)
    expect(trialBarPercent(0)).toBe(0)
  })
  it('an admin-extended trial (up to 365 days) never overflows the track', () => {
    expect(trialBarPercent(60)).toBe(100)
    expect(trialBarPercent(365)).toBe(100)
    for (let d = 0; d <= 400; d++) {
      const p = trialBarPercent(d)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(100)
    }
  })
  it('garbage in is an empty bar, not NaN%', () => {
    expect(trialBarPercent(NaN)).toBe(0)
    expect(trialBarPercent(-3)).toBe(0)
    expect(trialBarPercent(Infinity)).toBe(0)
  })
})

describe('isOneActiveTrialConflict', () => {
  it('matches only the one-active-trial unique violation', () => {
    expect(isOneActiveTrialConflict({ code: '23505', message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"' })).toBe(true)
    expect(isOneActiveTrialConflict({ code: '23505', message: 'violates unique constraint "workspaces_slug_key"' })).toBe(false)
    expect(isOneActiveTrialConflict({ code: '42501', message: 'one_active_trial_per_creator' })).toBe(false)
    expect(isOneActiveTrialConflict({ code: '23505' })).toBe(false)
    expect(isOneActiveTrialConflict(null)).toBe(false)
    expect(isOneActiveTrialConflict(undefined)).toBe(false)
  })
})

// A just-enough PostgREST fake for filterByNotificationPreference: a maybeSingle() read of the workspace default and an
// awaited .in() read of per-member overrides.
function fakeService(opts: { def?: any; prefs?: any[]; fail?: boolean }) {
  const reads: Array<{ table: string; filters: Record<string, any> }> = []
  return {
    reads,
    from(table: string) {
      const q: any = { filters: {} as Record<string, any> }
      q.select = () => q
      q.eq = (c: string, v: any) => { q.filters[c] = v; return q }
      q.in = (c: string, v: any) => { q.filters[c] = v; return q }
      q.maybeSingle = async () => {
        reads.push({ table, filters: q.filters })
        return opts.fail ? { data: null, error: { message: 'boom' } } : { data: opts.def ?? null, error: null }
      }
      q.then = (res: any, rej: any) => {
        reads.push({ table, filters: q.filters })
        return Promise.resolve(opts.fail ? { data: null, error: { message: 'boom' } } : { data: opts.prefs ?? [], error: null }).then(res, rej)
      }
      return q
    },
  }
}

const RECIPIENTS = [
  { id: 'u1', name: 'A', email: 'a@x.test' },
  { id: 'u2', name: 'B', email: 'b@x.test' },
  { id: 'u3', name: 'C', email: 'c@x.test' },
  { name: 'NoId', email: 'n@x.test' },
]
const emails = (r: Array<{ email: string }>) => r.map(x => x.email)

describe('applyTrialEndingPreference (day-0 trial-expiry email audience)', () => {
  it('drops a member who muted trial_ending, keeps the rest in order, never looks up an id-less recipient', async () => {
    const svc = fakeService({ prefs: [{ user_id: 'u2', email_enabled: false }, { user_id: 'u1', email_enabled: true }] })
    expect(emails(await applyTrialEndingPreference(svc, 'w1', RECIPIENTS))).toEqual(['a@x.test', 'c@x.test', 'n@x.test'])
    const q = svc.reads.find(r => r.table === 'notification_preferences')!
    expect(q.filters.event_type).toBe('trial_ending')
    expect(q.filters.workspace_id).toBe('w1')
    expect(q.filters.user_id).toEqual(['u1', 'u2', 'u3'])
  })

  it('a workspace default of OFF applies unless the member opted back in', async () => {
    const svc = fakeService({ def: { email_enabled: false, locked: false }, prefs: [{ user_id: 'u1', email_enabled: true }] })
    expect(emails(await applyTrialEndingPreference(svc, 'w1', RECIPIENTS))).toEqual(['a@x.test', 'n@x.test'])
  })

  it('a NULL member preference inherits the workspace default', async () => {
    const svc = fakeService({ def: { email_enabled: false, locked: false }, prefs: [{ user_id: 'u1', email_enabled: null }] })
    expect(emails(await applyTrialEndingPreference(svc, 'w1', RECIPIENTS))).toEqual(['n@x.test'])
  })

  it('a locked workspace default beats any member override', async () => {
    const off = fakeService({ def: { email_enabled: false, locked: true }, prefs: [{ user_id: 'u1', email_enabled: true }] })
    expect(emails(await applyTrialEndingPreference(off, 'w1', RECIPIENTS))).toEqual(['n@x.test'])
    const on = fakeService({ def: { email_enabled: true, locked: true }, prefs: [{ user_id: 'u2', email_enabled: false }] })
    expect(await applyTrialEndingPreference(on, 'w1', RECIPIENTS)).toHaveLength(4)
  })

  it('fails OPEN: if the preference reads fail, the lapsed-plan notice is still sent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = fakeService({ fail: true })
    expect(await applyTrialEndingPreference(svc, 'w1', RECIPIENTS)).toHaveLength(4)
    spy.mockRestore()
  })

  it('no identifiable recipient means no lookup at all', async () => {
    const boom: any = { from() { throw new Error('must not query') } }
    const anon = [{ name: 'x', email: 'x@x.test' }]
    expect(await applyTrialEndingPreference(boom, 'w1', anon)).toBe(anon)
    expect(await applyTrialEndingPreference(boom, 'w1', [])).toEqual([])
  })
})
