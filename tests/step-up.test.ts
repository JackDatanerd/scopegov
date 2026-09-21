import { describe, it, expect } from 'vitest'
import { isFreshlyAuthenticated, requireStepUp, STEP_UP_WINDOW_SECONDS, stepUpSessionKey } from '@/lib/auth/step-up'

const now = 1_800_000_000
const tok = (amr: any[], extra: any = {}) => ({ iat: now, amr, session_id: 'sess-1', ...extra })

function fakes(opts: { payload: any; factors?: Array<{ status: string }>; grant?: boolean; hasPassword?: boolean }) {
  const jwt = 'h.' + Buffer.from(JSON.stringify(opts.payload)).toString('base64url') + '.s'
  const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: jwt } } }) } }
  const service = {
    from: () => { const q: any = {}; q.select = () => q; q.eq = () => q; q.gt = () => q; q.limit = async () => ({ data: opts.grant ? [{ id: 'g' }] : [] }); return q },
    rpc: async () => ({ data: opts.hasPassword ?? false }),
  }
  return { supabase, service, user: { id: 'u1', factors: opts.factors ?? [] } }
}

describe('isFreshlyAuthenticated', () => {
  it('no second factor: a sign-in inside the window counts, an old one does not', () => {
    expect(isFreshlyAuthenticated(tok([{ method: 'password', timestamp: now - 60 }]), false, now)).toBe(true)
    expect(isFreshlyAuthenticated(tok([{ method: 'password', timestamp: now - STEP_UP_WINDOW_SECONDS - 5 }]), false, now)).toBe(false)
  })
  it('token refreshes never make an old sign-in fresh', () => {
    expect(isFreshlyAuthenticated(tok([{ method: 'password', timestamp: now - 3600 }, { method: 'token_refresh', timestamp: now - 5 }]), false, now)).toBe(false)
  })
  it('with a second factor only a RECENT totp step counts — a fresh password alone does not', () => {
    expect(isFreshlyAuthenticated(tok([{ method: 'password', timestamp: now - 30 }, { method: 'totp', timestamp: now - 3600 }]), true, now)).toBe(false)
    expect(isFreshlyAuthenticated(tok([{ method: 'password', timestamp: now - 3600 }, { method: 'totp', timestamp: now - 30 }]), true, now)).toBe(true)
  })
})

describe('requireStepUp', () => {
  // requireStepUp reads the real clock, so these are relative to it (not the fixed `now` above).
  const realNow = () => Math.floor(Date.now() / 1000)
  const stale = [{ method: 'password', timestamp: realNow() - 7200 }]
  const staleMfa = [{ method: 'password', timestamp: realNow() - 7200 }, { method: 'totp', timestamp: realNow() - 7100 }]

  it('lets a fresh sign-in straight through', async () => {
    const t = realNow()
    const f = fakes({ payload: tok([{ method: 'password', timestamp: t - 30 }]) })
    expect(await requireStepUp(f.supabase, f.service, f.user)).toBeNull()
  })

  it('asks a stale MFA account for a TOTP code (401 step_up_required)', async () => {
    const f = fakes({ payload: tok(staleMfa), factors: [{ status: 'verified' }] })
    const res = await requireStepUp(f.supabase, f.service, f.user)
    expect(res?.status).toBe(401)
    expect(await res!.json()).toMatchObject({ code: 'step_up_required', methods: ['totp'] })
  })

  it('asks a stale password account for its password', async () => {
    const f = fakes({ payload: tok(stale), hasPassword: true })
    expect(await (await requireStepUp(f.supabase, f.service, f.user))!.json()).toMatchObject({ methods: ['password'] })
  })

  it('a passwordless (OAuth) account with a stale sign-in is told to sign in again (no methods)', async () => {
    const f = fakes({ payload: tok(stale), hasPassword: false })
    const body = await (await requireStepUp(f.supabase, f.service, f.user))!.json()
    expect(body.methods).toEqual([])
    expect(body.code).toBe('step_up_required')
  })

  it('a valid grant for THIS session satisfies it', async () => {
    const f = fakes({ payload: tok(staleMfa), factors: [{ status: 'verified' }], grant: true })
    expect(await requireStepUp(f.supabase, f.service, f.user)).toBeNull()
  })

  it('keys grants to the session id (falls back to the user id)', () => {
    expect(stepUpSessionKey({ session_id: 'abc' } as any, 'u1')).toBe('abc')
    expect(stepUpSessionKey({} as any, 'u1')).toBe('nosession:u1')
  })
})
