import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// FIX (fresh independent audit, section 4 — feature gap): on the one_active_trial_per_creator
// 409, the onboarding wizard's "Go to that workspace instead" button used to just reload
// /onboarding, which only ever resolves to /dashboard when the ACTIVE workspace is already
// complete — so when the conflicting trial was a different, abandoned workspace (the ordinary
// case: you hit this because you're mid-onboarding on ANOTHER one), there was no way to reach it
// from that screen at all. The route now looks up and names the conflicting workspace on the 409.

function builder(result: any) {
  const b: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: any, rej: any) =>
          result instanceof Error ? Promise.reject(result).then(res, rej) : Promise.resolve(result).then(res, rej)
      }
      return (..._a: any[]) => b
    },
  })
  return b
}

let tables: Record<string, any> = {}
let rpcError: any = null

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => builder(tables[t] ?? { data: null, error: null }),
    rpc: async () => ({ error: rpcError }),
  }),
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  }),
}))
vi.mock('@/lib/email/templates', async () => {
  const actual: any = await vi.importActual('@/lib/email/templates')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => ({})]))
})

const req = (body: any) => new NextRequest('http://localhost/api/workspace/create', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})
const validBody = { agencyName: 'Acme Agency', industry: 'Web & App Development' }

beforeEach(() => {
  tables = {
    // users.deleted_at check
    users: { data: { deleted_at: null }, error: null },
  }
  rpcError = null
})

describe('POST /api/workspace/create — trial-conflict workspace id', () => {
  it('names the conflicting workspace when the caller is still an active member of it', async () => {
    rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"' }
    tables.workspaces = { data: { id: 'w-old-trial' }, error: null }
    tables.workspace_members = { data: { id: 'mem-1' }, error: null }
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.conflictWorkspaceId).toBe('w-old-trial')
  })

  it('omits conflictWorkspaceId when the caller is no longer an active member (e.g. an admin-suspended trial)', async () => {
    rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"' }
    tables.workspaces = { data: { id: 'w-old-trial' }, error: null }
    tables.workspace_members = { data: null, error: null } // no active membership row
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.conflictWorkspaceId).toBeUndefined()
  })

  it('omits conflictWorkspaceId (rather than failing the request) when the lookup itself throws', async () => {
    rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"' }
    tables.workspaces = new Error('db unavailable') // simulates a network-level failure, not just a query error field
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.conflictWorkspaceId).toBeUndefined()
    expect(json.error).toMatch(/active trial workspace/i)
  })

  it('a different constraint violation is unaffected (no conflict lookup, generic failure)', async () => {
    rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "workspaces_slug_key"' }
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.conflictWorkspaceId).toBeUndefined()
  })
})
