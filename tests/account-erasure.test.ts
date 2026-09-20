import { describe, it, expect, vi } from 'vitest'
import { anonymizeAuthUser, anonymizedEmail, banAuthUser, isAuthUserBanned } from '@/lib/utils/account-erasure'

function svc(overrides: any = {}) {
  const updateUserById = vi.fn().mockResolvedValue({ error: null })
  const listFactors = vi.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }, { id: 'f2' }] } })
  const deleteFactor = vi.fn().mockResolvedValue({ error: null })
  const getUserById = vi.fn().mockResolvedValue({ data: { user: { banned_until: null } }, error: null })
  const service = { auth: { admin: { updateUserById, getUserById, mfa: { listFactors, deleteFactor } } } }
  Object.assign(service.auth.admin, overrides)
  return { service, updateUserById, listFactors, deleteFactor, getUserById }
}

describe('account erasure', () => {
  it('bans the auth user', async () => {
    const { service, updateUserById } = svc()
    expect(await banAuthUser(service, 'u1')).toEqual({ ok: true })
    expect(updateUserById).toHaveBeenCalledWith('u1', { ban_duration: '876000h' })
  })
  it('anonymizes email, password and metadata, and removes MFA factors', async () => {
    const { service, updateUserById, deleteFactor } = svc()
    expect((await anonymizeAuthUser(service, 'u1')).ok).toBe(true)
    const arg = updateUserById.mock.calls[0][1]
    expect(arg.email).toBe(anonymizedEmail('u1'))
    expect(arg.user_metadata).toEqual({})
    expect(typeof arg.password).toBe('string')
    expect(arg.password.length).toBeGreaterThanOrEqual(32)
    expect(deleteFactor).toHaveBeenCalledTimes(2)
  })
  it('reports failure (so the caller leaves public.users untouched and retries) when the auth update fails', async () => {
    const { service } = svc({ updateUserById: vi.fn().mockResolvedValue({ error: { message: 'db down' } }) })
    expect(await anonymizeAuthUser(service, 'u1')).toEqual({ ok: false, error: 'db down' })
  })
  it('treats a missing auth user as already erased', async () => {
    const { service } = svc({ updateUserById: vi.fn().mockResolvedValue({ error: { message: 'User not found', status: 404 } }) })
    expect((await anonymizeAuthUser(service, 'u1')).ok).toBe(true)
  })
  it('detects an existing ban', async () => {
    const future = new Date(Date.now() + 1e9).toISOString()
    expect(await isAuthUserBanned(svc({ getUserById: vi.fn().mockResolvedValue({ data: { user: { banned_until: future } }, error: null }) }).service, 'u')).toBe(true)
    expect(await isAuthUserBanned(svc().service, 'u')).toBe(false)
    expect(await isAuthUserBanned(svc({ getUserById: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }) }).service, 'u')).toBeNull()
  })
})
