import { describe, it, expect, beforeEach, vi } from 'vitest'

let existing: any = null
let written: Array<{ op: 'insert' | 'update'; payload: any }> = []

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'maybeSingle') return async () => ({ data: existing, error: null })
          if (prop === 'insert') return async (payload: any) => { written.push({ op: 'insert', payload }); return { error: null } }
          if (prop === 'update') return (payload: any) => { written.push({ op: 'update', payload }); return { eq: async () => ({ error: null }) } }
          return () => chain
        },
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.test', name: 'A', workspaceId: 'w1', workspaceName: 'W' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))

import { PATCH } from '@/app/api/workspace/notification-defaults/route'

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => { existing = null; written = [] })

describe('PATCH /api/workspace/notification-defaults', () => {
  it('leaves an existing row\'s bell default alone when the admin only changes the email default', async () => {
    existing = { id: 'row1' }
    const res = await PATCH(req({ eventType: 'sow_signed', enabled: false, locked: false }))
    expect(res.status).toBe(200)
    expect(written[0].op).toBe('update')
    expect(written[0].payload).toMatchObject({ email_enabled: false, locked: false })
    expect('in_app_enabled' in written[0].payload).toBe(false)
  })

  it('writes the bell default of an email event when it is supplied', async () => {
    existing = { id: 'row1' }
    await PATCH(req({ eventType: 'sow_signed', enabled: true, locked: false, inAppEnabled: false }))
    expect(written[0].payload).toMatchObject({ email_enabled: true, in_app_enabled: false })
  })

  it('a brand-new row starts with the bell on', async () => {
    await PATCH(req({ eventType: 'sow_signed', enabled: true, locked: true }))
    expect(written[0].op).toBe('insert')
    expect(written[0].payload).toMatchObject({ in_app_enabled: true, locked: true })
  })

  it('an in-app-only event sets in_app_enabled from `enabled`', async () => {
    await PATCH(req({ eventType: 'member_joined', enabled: false, locked: false }))
    expect(written[0].payload).toMatchObject({ in_app_enabled: false, email_enabled: true })
  })

  it('rejects a non-boolean inAppEnabled, and unknown event types', async () => {
    expect((await PATCH(req({ eventType: 'sow_signed', enabled: true, locked: false, inAppEnabled: 'no' }))).status).toBe(400)
    expect((await PATCH(req({ eventType: 'nope', enabled: true, locked: false }))).status).toBe(400)
    expect(written).toHaveLength(0)
  })
})
