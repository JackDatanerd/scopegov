import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for the Workspace lifecycle independent re-pass: a person whose ONLY workspace a
// platform admin suspended has zero active memberships, so onboarding-status returned 'create' — the
// exact answer a brand-new signup gets — and the wizard offered them a blank new-agency form with no
// mention of the suspension. It now answers 'suspended' (and only for members that suspension itself
// deactivated; self-service deletes and long-departed members are left alone).

let activeRows: any[]
let deactivatedRows: any[]

function builder(table: string) {
  let statusFilter: string | null = null
  const b: any = {
    select: () => b, order: () => b, not: () => b, is: () => b, limit: () => b,
    eq: (c: string, v: any) => { if (c === 'status') statusFilter = v; return b },
    maybeSingle: () => Promise.resolve({ data: table === 'users' ? { active_workspace_id: null } : null, error: null }),
    then: (resolve: any, reject: any) => {
      const data = table === 'workspace_members'
        ? (statusFilter === 'deactivated' ? deactivatedRows : activeRows)
        : []
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    },
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  createServiceClient: () => ({ from: (t: string) => builder(t) }),
}))

import { GET } from '@/app/api/workspace/onboarding-status/route'

const T = '2026-09-20T10:00:00.000Z'
const suspendedRow = (over: any = {}) => ({
  workspace_id: 'w-susp', deactivated_at: T,
  workspaces: { id: 'w-susp', name: 'acme', agency_name: 'Acme Agency', deleted_at: T, suspended_by_admin: true },
  ...over,
})

beforeEach(() => { activeRows = []; deactivatedRows = [] })

describe('GET /api/workspace/onboarding-status — suspended workspaces', () => {
  it("answers 'suspended' (not 'create') when the user's only way in was an admin-suspended workspace", async () => {
    deactivatedRows = [suspendedRow()]
    const body = await (await GET()).json()
    expect(body).toEqual({ status: 'suspended', workspaceId: 'w-susp', agencyName: 'Acme Agency' })
  })

  it("still answers 'create' for a genuinely new user", async () => {
    expect(await (await GET()).json()).toEqual({ status: 'create' })
  })

  it("ignores a member who left/was removed at a different time than the suspension", async () => {
    deactivatedRows = [suspendedRow({ deactivated_at: '2026-01-01T00:00:00.000Z' })]
    expect(await (await GET()).json()).toEqual({ status: 'create' })
  })

  it("matches timestamps by instant, not by string format", async () => {
    deactivatedRows = [suspendedRow({ deactivated_at: '2026-09-20T10:00:00+00:00' })]
    expect((await (await GET()).json()).status).toBe('suspended')
  })

  it('picks the most recently suspended workspace when several match', async () => {
    const newer = '2026-09-25T10:00:00.000Z'
    deactivatedRows = [
      suspendedRow(),
      suspendedRow({ workspace_id: 'w-new', deactivated_at: newer,
        workspaces: { id: 'w-new', name: 'beta', agency_name: 'Beta', deleted_at: newer, suspended_by_admin: true } }),
    ]
    expect((await (await GET()).json()).workspaceId).toBe('w-new')
  })
})
