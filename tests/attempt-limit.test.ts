import { describe, it, expect } from 'vitest'
import {
  checkAuthAttemptLimit, recordAuthFailure, clearAuthFailures, lockoutMessage, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'

// Minimal in-memory stand-in for the slice of the supabase-js builder the
// limiter uses (select/eq/gte/order/limit, insert, delete).
function fakeService(rows: Array<{ user_id: string; kind: string; succeeded: boolean; created_at: string }>, opts: { failSelect?: boolean } = {}) {
  return {
    rows,
    from(_table: string) {
      const filters: Array<(r: any) => boolean> = []
      let orderDesc = false
      let lim = Infinity
      let mode: 'select' | 'delete' = 'select'
      const builder: any = {
        select() { mode = 'select'; return builder },
        delete() { mode = 'delete'; return builder },
        insert(row: any) { rows.push({ succeeded: false, created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null }) },
        eq(col: string, v: any) { filters.push(r => r[col] === v); return builder },
        gte(col: string, v: string) { filters.push(r => r[col] >= v); return builder },
        order(_c: string, o: { ascending: boolean }) { orderDesc = o.ascending === false; return builder },
        limit(n: number) { lim = n; return builder },
        then(resolve: any) {
          if (opts.failSelect) return resolve({ data: null, error: { message: 'boom' } })
          let out = rows.filter(r => filters.every(f => f(r)))
          if (mode === 'delete') { for (const r of out) rows.splice(rows.indexOf(r), 1); return resolve({ error: null }) }
          if (orderDesc) out = out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          return resolve({ data: out.slice(0, lim).map(r => ({ created_at: r.created_at })), error: null })
        },
      }
      return builder
    },
  }
}

const NOW = Date.parse('2026-09-20T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const fail = (user: string, msAgo: number, kind = 'mfa_verify') => ({ user_id: user, kind, succeeded: false, created_at: iso(msAgo) })

describe('checkAuthAttemptLimit', () => {
  it('allows attempts below the failure limit', async () => {
    const svc = fakeService([fail('u1', 10_000), fail('u1', 20_000)])
    const r = await checkAuthAttemptLimit(svc, 'u1', 'mfa_verify', NOW)
    expect(r).toEqual({ allowed: true, retryAfterSeconds: 0, failures: 2 })
  })

  it('locks after the maximum failures inside the window and reports when it ends', async () => {
    const { maxFailures, windowSeconds } = AUTH_ATTEMPT_LIMIT
    const rows = Array.from({ length: maxFailures }, (_, i) => fail('u1', (i + 1) * 30_000))
    const r = await checkAuthAttemptLimit(fakeService(rows), 'u1', 'mfa_verify', NOW)
    expect(r.allowed).toBe(false)
    // oldest counted failure is maxFailures*30s old -> lock ends when it is windowSeconds old
    expect(r.retryAfterSeconds).toBe(windowSeconds - maxFailures * 30)
  })

  it('ignores failures that have aged out of the window', async () => {
    const old = Array.from({ length: 8 }, () => fail('u1', (AUTH_ATTEMPT_LIMIT.windowSeconds + 60) * 1000))
    const r = await checkAuthAttemptLimit(fakeService(old), 'u1', 'mfa_verify', NOW)
    expect(r.allowed).toBe(true)
  })

  it('is per user and per kind', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => fail('u1', (i + 1) * 1000))
    const svc = fakeService(rows)
    expect((await checkAuthAttemptLimit(svc, 'u2', 'mfa_verify', NOW)).allowed).toBe(true)
    expect((await checkAuthAttemptLimit(svc, 'u1', 'mfa_recover', NOW)).allowed).toBe(true)
    expect((await checkAuthAttemptLimit(svc, 'u1', 'mfa_verify', NOW)).allowed).toBe(false)
  })

  it('fails OPEN when the ledger errors (GoTrue limits still apply)', async () => {
    const r = await checkAuthAttemptLimit(fakeService([], { failSelect: true }), 'u1', 'mfa_verify', NOW)
    expect(r.allowed).toBe(true)
  })
})

describe('recordAuthFailure / clearAuthFailures', () => {
  it('records a failure and a success wipes that kind\'s failures only', async () => {
    const svc = fakeService([fail('u1', 1000, 'mfa_recover')])
    await recordAuthFailure(svc, 'u1', 'mfa_verify')
    expect(svc.rows.filter(r => r.kind === 'mfa_verify')).toHaveLength(1)
    await clearAuthFailures(svc, 'u1', 'mfa_verify')
    expect(svc.rows.filter(r => r.kind === 'mfa_verify')).toHaveLength(0)
    expect(svc.rows.filter(r => r.kind === 'mfa_recover')).toHaveLength(1)
  })
})

describe('lockoutMessage', () => {
  it('rounds up to whole minutes and pluralises', () => {
    expect(lockoutMessage(1)).toContain('1 minute.')
    expect(lockoutMessage(61)).toContain('2 minutes.')
  })
})
