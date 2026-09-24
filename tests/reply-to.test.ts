import { describe, it, expect } from 'vitest'
import { resolveReplyTo } from '@/lib/email/reply-to'

// A tiny table-driven stand-in for the PostgREST builder.
function svc(tables: Record<string, any>) {
  return {
    from: (t: string) => {
      const chain: any = new Proxy({}, {
        get(_x, prop: string) {
          if (prop === 'maybeSingle') return async () => ({ data: tables[t] ?? null, error: null })
          return () => chain
        },
      })
      return chain
    },
  }
}

describe('resolveReplyTo', () => {
  it('prefers the workspace reply-to address', async () => {
    const s = svc({ workspaces: { reply_to_email: 'billing@agency.test', created_by: 'u1' } })
    expect(await resolveReplyTo(s, 'w1', 'actor@agency.test')).toBe('billing@agency.test')
  })

  it('then the person who triggered the send', async () => {
    const s = svc({ workspaces: { reply_to_email: null } })
    expect(await resolveReplyTo(s, 'w1', 'actor@agency.test')).toBe('actor@agency.test')
  })

  it('falls back to the active workspace owner when a client or a cron triggered the send', async () => {
    const s = svc({
      workspaces: { reply_to_email: null, created_by: 'u1' },
      workspace_members: { users: { email: 'owner@agency.test' } },
    })
    expect(await resolveReplyTo(s, 'w1', null)).toBe('owner@agency.test')
  })

  it('is null when nobody can receive the reply (owner left, anonymised or no reply-to)', async () => {
    expect(await resolveReplyTo(svc({ workspaces: { reply_to_email: null, created_by: 'u1' } }), 'w1', null)).toBeNull()
    const gone = svc({
      workspaces: { reply_to_email: null, created_by: 'u1' },
      workspace_members: { users: { email: 'x@deleted.scopegov.app' } },
    })
    expect(await resolveReplyTo(gone, 'w1', null)).toBeNull()
  })
})
