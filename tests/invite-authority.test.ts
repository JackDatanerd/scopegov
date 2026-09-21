import { describe, it, expect } from 'vitest'
import { inviterMayStillGrant } from '@/lib/utils/invite-authority'
import { isProtectedOwnerTarget } from '@/lib/utils/owner-protection'
import { describeUserAgent } from '@/lib/auth/session-seen'

function svc(tables: Record<string, any>) {
  return {
    from: (t: string) => {
      const b: any = new Proxy(function () {}, {
        get(_x, prop) {
          if (prop === 'then') return (res: any) => Promise.resolve({ data: tables[t] ?? null, error: null }).then(res)
          if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: tables[t] ?? null, error: null })
          return () => b
        },
      })
      return b
    },
  }
}

describe('inviterMayStillGrant', () => {
  const role = { permissions: { VIEW_ALL_PROJECTS: true, VIEW_FINANCIALS: true } }
  it('allows an active inviter who still holds INVITE_MEMBERS and every permission of the role', async () => {
    const s = svc({ workspace_members: { effective_permissions: { INVITE_MEMBERS: true, VIEW_ALL_PROJECTS: true, VIEW_FINANCIALS: true } }, roles: role })
    expect(await inviterMayStillGrant(s, 'w', 'inviter', 'r')).toBe(true)
  })
  it('refuses when the inviter is no longer an active member (deactivated / left)', async () => {
    expect(await inviterMayStillGrant(svc({ workspace_members: null, roles: role }), 'w', 'inviter', 'r')).toBe(false)
  })
  it('refuses when the inviter lost INVITE_MEMBERS', async () => {
    const s = svc({ workspace_members: { effective_permissions: { VIEW_ALL_PROJECTS: true, VIEW_FINANCIALS: true } }, roles: role })
    expect(await inviterMayStillGrant(s, 'w', 'inviter', 'r')).toBe(false)
  })
  it('refuses when the inviter was demoted below the role that was offered', async () => {
    const s = svc({ workspace_members: { effective_permissions: { INVITE_MEMBERS: true, VIEW_ALL_PROJECTS: true } }, roles: role })
    expect(await inviterMayStillGrant(s, 'w', 'inviter', 'r')).toBe(false)
  })
  it('cannot judge an invite with no recorded inviter, so it is allowed', async () => {
    expect(await inviterMayStillGrant(svc({}), 'w', null, 'r')).toBe(true)
  })
})

describe('isProtectedOwnerTarget', () => {
  const s = svc({ workspaces: { created_by: 'owner1' } })
  it('protects the owner from everybody else', async () => {
    expect(await isProtectedOwnerTarget(s, 'w', 'admin', 'owner1')).toBe(true)
  })
  it('does not block the owner acting on themselves, or anyone else being acted on', async () => {
    expect(await isProtectedOwnerTarget(s, 'w', 'owner1', 'owner1')).toBe(false)
    expect(await isProtectedOwnerTarget(s, 'w', 'admin', 'member2')).toBe(false)
    expect(await isProtectedOwnerTarget(s, 'w', 'admin', null)).toBe(false)
  })
})

describe('describeUserAgent (new-device key)', () => {
  const chromeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  const chromeWin2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
  const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
  it('names the browser and OS', () => {
    expect(describeUserAgent(chromeWin).device).toBe('Chrome on Windows')
    expect(describeUserAgent(safariMac).device).toBe('Safari on macOS')
  })
  it('a browser update is the SAME device; a different browser/OS is a new one', () => {
    expect(describeUserAgent(chromeWin).key).toBe(describeUserAgent(chromeWin2).key)
    expect(describeUserAgent(chromeWin).key).not.toBe(describeUserAgent(safariMac).key)
  })
})
