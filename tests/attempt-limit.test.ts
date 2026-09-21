import { describe, it, expect } from 'vitest'
import {
  beginAuthAttempt, releaseAuthAttempt, clearAuthFailures, lockoutMessage, lockedResponseBody, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'

// The atomicity itself lives in SQL (auth_attempt_begin) and is exercised against a real
// Postgres in tests/pg-replay/. These tests cover the TypeScript contract around it.

function fakeService(rpcImpl: (name: string, args: any) => { data?: any; error?: any } | Promise<any>) {
  const calls: Array<{ name: string; args: any }> = []
  const deletes: Array<Record<string, unknown>> = []
  return {
    calls, deletes,
    rpc: async (name: string, args: any) => { calls.push({ name, args }); return rpcImpl(name, args) },
    from: (_t: string) => {
      const filters: Record<string, unknown> = {}
      const q: any = {
        delete: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q },
        then: (res: any) => { deletes.push({ ...filters }); return Promise.resolve({ error: null }).then(res) },
      }
      return q
    },
  }
}

describe('beginAuthAttempt', () => {
  it('sends the ledger parameters to the atomic RPC and maps an allowed result', async () => {
    const svc = fakeService(() => ({ data: { allowed: true, attempt_id: 'a1', failures: 2, retry_after_seconds: 0 } }))
    const r = await beginAuthAttempt(svc, 'u1', 'mfa_verify')
    expect(svc.calls[0]).toEqual({ name: 'auth_attempt_begin', args: {
      p_user: 'u1', p_kind: 'mfa_verify', p_max: AUTH_ATTEMPT_LIMIT.maxFailures, p_window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds,
    } })
    expect(r).toEqual({ allowed: true, retryAfterSeconds: 0, failures: 2, attemptId: 'a1' })
  })

  it('maps a locked result (no attempt id, retry-after present)', async () => {
    const svc = fakeService(() => ({ data: { allowed: false, attempt_id: null, failures: 5, retry_after_seconds: 240 } }))
    const r = await beginAuthAttempt(svc, 'u1', 'mfa_recover')
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSeconds).toBe(240)
    expect(r.attemptId).toBeNull()
  })

  it('fails OPEN when the ledger errors (GoTrue limits still apply)', async () => {
    const svc = fakeService(() => ({ error: { message: 'db down' } }))
    const r = await beginAuthAttempt(svc, 'u1', 'password_verify')
    expect(r.allowed).toBe(true)
    expect(r.attemptId).toBeNull()
  })

  it('fails OPEN when the RPC throws', async () => {
    const svc = fakeService(() => { throw new Error('network') })
    expect((await beginAuthAttempt(svc, 'u1', 'mfa_verify')).allowed).toBe(true)
  })
})

describe('releaseAuthAttempt / clearAuthFailures', () => {
  it('releases a reservation by id, and does nothing without one', async () => {
    const svc = fakeService(() => ({ data: null }))
    await releaseAuthAttempt(svc, 'a1')
    await releaseAuthAttempt(svc, null)
    expect(svc.calls).toEqual([{ name: 'auth_attempt_release', args: { p_attempt: 'a1' } }])
  })

  it('clears only that user + kind\'s failures', async () => {
    const svc = fakeService(() => ({ data: null }))
    await clearAuthFailures(svc, 'u1', 'mfa_verify')
    expect(svc.deletes[0]).toEqual({ user_id: 'u1', kind: 'mfa_verify', succeeded: false })
  })
})

describe('lockout messaging', () => {
  it('rounds up to whole minutes, singular/plural', () => {
    expect(lockoutMessage(1)).toBe('Too many incorrect attempts. Try again in 1 minute.')
    expect(lockoutMessage(61)).toBe('Too many incorrect attempts. Try again in 2 minutes.')
  })
  it('builds the standard 429 body', () => {
    const body = lockedResponseBody({ allowed: false, retryAfterSeconds: 120, failures: 5, attemptId: null })
    expect(body).toMatchObject({ code: 'locked', retryAfterSeconds: 120 })
  })
})
