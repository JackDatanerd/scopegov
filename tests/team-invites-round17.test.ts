// tests/team-invites-round17.test.ts
//
// Regression tests for Team & Invites round 17:
//   B1 — Team page treated failed reads as an empty team
//   B2 — bare `await res.json()` in TeamClient / invite page (raw parse errors, blank messages)
//   B3 — invite revoke skipped the role ceiling for an invite with no explicit role
//   B4 — seat-limit message printed "Trial (14 days) plan"
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          calls.push({ table, ops })
          return Promise.resolve(resolver(table, ops)).then(res, rej)
        }
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: [], error: null }) }),
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'actor' } } }) } }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error('redirect:' + u) } }))

const read = (p: string) => readFileSync(p, 'utf8')

beforeEach(() => {
  calls.length = 0
  resolver = () => ({ data: null, error: null })
  session = {
    id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com', agencyName: 'Acme',
    workspaceName: 'Acme', planTier: 'agency', permissions: ['INVITE_MEMBERS'],
  }
})

describe('B1: Team page does not render a failed read as an empty team', () => {
  it('shows the load-error state when the members read fails', async () => {
    resolver = (table) => table === 'workspace_members' ? { data: null, error: { message: 'connection reset' } } : { data: [], error: null }
    const { default: TeamPage } = await import('@/app/(app)/team/page')
    const el: any = await TeamPage()
    expect(el.type.name).toBe('TeamLoadError')
  })
  it('shows the load-error state when the roles read fails', async () => {
    resolver = (table) => table === 'roles' ? { data: null, error: { message: 'boom' } } : { data: [], error: null }
    const { default: TeamPage } = await import('@/app/(app)/team/page')
    const el: any = await TeamPage()
    expect(el.type.name).toBe('TeamLoadError')
  })
})

describe('B2: no unguarded res.json() left in the team UI', () => {
  it('TeamClient parses every response defensively', () => {
    const bare = read('components/team/TeamClient.tsx').split('\n')
      .filter(l => l.includes('await res.json()') && !l.includes('.catch') && !l.trim().startsWith('//'))
    expect(bare).toEqual([])
  })
  it('invite page signup + existing-user paths never throw an empty / raw error', () => {
    const src = read('app/invite/[token]/page.tsx')
    expect(src).not.toMatch(/throw new Error\(json\.error\)/)
    expect(src).not.toMatch(/throw new Error\(j\.error\)/)
    expect(src).not.toMatch(/const json = await res\.json\(\)\s*\n/)
  })
})

describe('B3: revoking a role-less invite is held to the default role\'s ceiling', () => {
  it('403s when the default role holds permissions the actor lacks, and deletes nothing', async () => {
    session.permissions = ['INVITE_MEMBERS']
    resolver = (table, ops) => {
      if (table === 'workspace_members' && ops.some(o => o.name === 'maybeSingle' || o.name === 'single')) {
        return { data: { id: 'm1', status: 'invited', user_id: null, role_id: null, invited_email: 'x@y.com', effective_permissions: {}, workspace_id: 'w1' }, error: null }
      }
      if (table === 'roles') {
        return { data: { id: 'r-default', name: 'Member', permissions: { INVITE_MEMBERS: true, MANAGE_BILLING: true } }, error: null }
      }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/team/[id]/route')
    const res = await DELETE(new NextRequest('http://localhost/api/team/m1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(403)
    expect(calls.some(c => c.table === 'workspace_members' && c.ops.some(o => o.name === 'delete'))).toBe(false)
  })
})

describe('B4: seat-limit message omits the trial duration parenthetical', () => {
  it('reads "on the Trial plan"', async () => {
    const src = read('lib/utils/seat-limit.ts')
    expect(src).toContain(".replace(/\\s*\\(.*\\)\\s*$/, '')")
    const name = 'Trial (14 days)'
    expect(name.replace(/\s*\(.*\)\s*$/, '')).toBe('Trial')
    expect('Starter'.replace(/\s*\(.*\)\s*$/, '')).toBe('Starter')
  })
})
