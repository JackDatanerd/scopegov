import { describe, it, expect, vi, beforeEach } from 'vitest'

// Onboarding independent pass 12 — B1: onboarding-status never checked users.deleted_at, the one wizard route
// that didn't. A suspended/deleted account's still-valid access token could read workspace + resume data.

let userRow: any
let memberRows: any[]

function builder(table: string) {
  const b: any = {
    select: () => b, order: () => b, not: () => b, is: () => b, limit: () => b, eq: () => b,
    maybeSingle: () => Promise.resolve({ data: table === 'users' ? userRow : null, error: null }),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: table === 'workspace_members' ? memberRows : [], error: null }).then(resolve, reject),
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  createServiceClient: () => ({ from: (t: string) => builder(t) }),
}))

import { GET } from '@/app/api/workspace/onboarding-status/route'

const ws = { id: 'w1', created_by: 'u1', onboarding_completed_at: null, name: 'a', agency_name: 'Acme', deleted_at: null }

beforeEach(() => {
  userRow = { active_workspace_id: 'w1', deleted_at: null }
  memberRows = [{ workspace_id: 'w1', workspaces: ws }]
})

describe('GET /api/workspace/onboarding-status — deleted/suspended accounts', () => {
  it('answers 401 and leaks nothing for an account with deleted_at set', async () => {
    userRow = { active_workspace_id: 'w1', deleted_at: '2026-10-01T00:00:00.000Z' }
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('still answers normally for a live account', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('resume')
  })
})
