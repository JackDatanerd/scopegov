// Workspace lifecycle round 21: list read errors, list effective plan tier, delete UI JSON guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let memberships: any = { data: [], error: null }
let userRow: any = { data: { active_workspace_id: null, deleted_at: null }, error: null }

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  createServiceClient: () => ({
    from: (table: string) => {
      const result = () => (table === 'users' ? userRow : memberships)
      const q: any = { select: () => q, eq: () => q, order: () => q, maybeSingle: async () => result(), then: (r: any) => r(result()) }
      return q
    },
  }),
}))

const row = (id: string, tier: string, trialEnds: string | null) => ({
  workspace_id: id, created_at: '2026-01-01',
  workspaces: { id, name: id, agency_name: id, logo_storage_path: null, plan_tier: tier, trial_ends_at: trialEnds, deleted_at: null, onboarding_completed_at: '2026-01-02' },
})

describe('GET /api/workspace/list', () => {
  beforeEach(() => {
    memberships = { data: [], error: null }
    userRow = { data: { active_workspace_id: null, deleted_at: null }, error: null }
  })

  it('answers 500, not an empty 200 list, when the memberships read fails', async () => {
    memberships = { data: null, error: { message: 'boom' } }
    const { GET } = await import('@/app/api/workspace/list/route')
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).workspaces).toBeUndefined()
  })

  it('answers 500 when the users read fails', async () => {
    userRow = { data: null, error: { message: 'boom' } }
    const { GET } = await import('@/app/api/workspace/list/route')
    expect((await GET()).status).toBe(500)
  })

  it('reports an expired trial as solo and a live trial as trial', async () => {
    memberships = { data: [
      row('expired', 'trial', '2020-01-01T00:00:00Z'),
      row('live', 'trial', '2999-01-01T00:00:00Z'),
      row('paid', 'studio', null),
    ], error: null }
    const { GET } = await import('@/app/api/workspace/list/route')
    const json = await (await GET()).json()
    const tier = (id: string) => json.workspaces.find((w: any) => w.id === id).planTier
    expect(tier('expired')).toBe('solo')
    expect(tier('live')).toBe('trial')
    expect(tier('paid')).toBe('studio')
  })
})
