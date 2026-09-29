// tests/settings-team-repass-3.test.ts
//
// Regression tests for the Settings + Team & Invites deep-audit re-pass,
// round 3 — the BrandingTab false-conflict bug. workspaces.updated_at moves
// on logo upload, logo removal, and signature save/clear, but none of those
// responses used to report the new value, so the client's cached
// expectedUpdatedAt went stale and the very next branding PATCH in the same
// session refused itself with a false "changed elsewhere" 409. The fix is
// that every one of these routes now echoes the fresh updated_at back so a
// caller can track it without waiting on a full page refresh. Same
// call-aware fake Supabase client pattern as tests/settings-team-repass-2.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any
let storageUploadError: any = null
let storageRemoveError: any = null

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
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    storage: {
      from: () => ({
        upload: async () => ({ error: storageUploadError }),
        remove: async () => ({ error: storageRemoveError }),
        list: async () => ({ data: [{ name: 'logo.png' }] }),
      }),
    },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const mkSession = (extra: any = {}) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com',
  agencyName: 'Acme', workspaceName: 'Acme', planTier: 'agency',
  permissions: ['MANAGE_WORKSPACE_SETTINGS'], ...extra,
})

beforeEach(() => {
  calls.length = 0
  storageUploadError = null
  storageRemoveError = null
  resolver = () => ({ data: null, error: null })
  session = mkSession()
})

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('R3-1: PATCH /api/workspace/branding echoes updatedAt', () => {
  it('returns the fresh updatedAt when a field actually changes', async () => {
    const now = '2026-09-26T00:00:00.000Z'
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) {
        return { data: { brand_colour: '#111111', logo_storage_path: null, agency_signature_data: null, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }
      }
      if (table === 'workspaces' && ops.some(o => o.name === 'update')) return { data: [{ id: 'w1' }], error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/branding/route')
    const req = new NextRequest('http://localhost/api/workspace/branding', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandColour: '#222222' }),
    })
    const res = await PATCH(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(typeof json.updatedAt).toBe('string')
    expect(json.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    void now
  })

  it('still returns the current updatedAt on the unchanged path (nothing to diff)', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) {
        return { data: { brand_colour: '#222222', logo_storage_path: null, agency_signature_data: null, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }
      }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/branding/route')
    // Same colour as what's already stored — diffFields finds no change.
    const req = new NextRequest('http://localhost/api/workspace/branding', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandColour: '#222222' }),
    })
    const res = await PATCH(req)
    const json = await res.json()
    expect(json.unchanged).toBe(true)
    expect(json.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('rejects a stale expectedUpdatedAt exactly as before (concurrency check unaffected)', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) {
        return { data: { brand_colour: '#111111', logo_storage_path: null, agency_signature_data: null, updated_at: '2026-02-01T00:00:00.000Z' }, error: null }
      }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/branding/route')
    const req = new NextRequest('http://localhost/api/workspace/branding', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandColour: '#222222', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }),
    })
    const res = await PATCH(req)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.conflicts).toEqual(['branding'])
  })
})

describe('R3-2: POST /api/workspace/branding/logo echoes updatedAt', () => {
  it('returns the fresh updatedAt alongside logoStoragePath', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'maybeSingle')) return { data: { logo_storage_path: null }, error: null }
      if (table === 'workspaces' && ops.some(o => o.name === 'update')) return { data: null, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/workspace/branding/logo/route')
    const file = new File([PNG_HEADER], 'logo.png', { type: 'image/png' })
    const form = new FormData()
    form.append('file', file)
    const req = new NextRequest('http://localhost/api/workspace/branding/logo', { method: 'POST', body: form as any })
    const res = await POST(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.logoStoragePath).toBe('w1/logo.png')
    expect(typeof json.updatedAt).toBe('string')
  })
})

describe('R3-3: DELETE /api/workspace/branding/logo echoes updatedAt', () => {
  it('returns the fresh updatedAt when a logo is actually removed', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'maybeSingle')) return { data: { logo_storage_path: 'w1/logo.png' }, error: null }
      if (table === 'workspaces' && ops.some(o => o.name === 'update')) return { data: null, error: null }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/workspace/branding/logo/route')
    const res = await DELETE()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(typeof json.updatedAt).toBe('string')
  })

  it('no-ops (no updatedAt) when there is nothing to remove', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'maybeSingle')) return { data: { logo_storage_path: null }, error: null }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/workspace/branding/logo/route')
    const res = await DELETE()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.updatedAt).toBeUndefined()
  })
})


// ═════════════════════════════════════════════════════════════════════════
// Settings independent pass (B2): the staleness check compared timestamp TEXT. The routes echo
// `new Date().toISOString()` ("...Z") but PostgREST returns the stored value as "...+00:00", so a
// client that had just received an echoed updatedAt could never match the row again.
// ═════════════════════════════════════════════════════════════════════════
describe('B2: branding staleness check compares instants, not strings', () => {
  const row = (updated_at: string) => ({ brand_colour: '#111111', logo_storage_path: null, agency_signature_data: null, updated_at })
  const patch = async (body: any) => {
    const { PATCH } = await import('@/app/api/workspace/branding/route')
    return PATCH(new NextRequest('http://localhost/api/workspace/branding', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
  }

  it('accepts an echoed "…Z" timestamp against the same instant stored as "…+00:00"', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) return { data: row('2026-09-29T08:41:58.155+00:00'), error: null }
      if (table === 'workspaces' && ops.some(o => o.name === 'update')) return { data: [{ id: 'w1' }], error: null }
      return { data: null, error: null }
    }
    const res = await patch({ brandColour: '#222222', expectedUpdatedAt: '2026-09-29T08:41:58.155Z' })
    expect(res.status).toBe(200)
  })

  it('still rejects a genuinely older timestamp', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) return { data: row('2026-09-29T08:41:58.155+00:00'), error: null }
      return { data: null, error: null }
    }
    const res = await patch({ brandColour: '#222222', expectedUpdatedAt: '2026-09-29T08:00:00.000Z' })
    expect(res.status).toBe(409)
    expect((await res.json()).conflicts).toEqual(['branding'])
  })

  it('refuses (409) when the row moved between the read and the write (compare-and-swap matched no row)', async () => {
    resolver = (table, ops) => {
      if (table === 'workspaces' && ops.some(o => o.name === 'single')) return { data: row('2026-09-29T08:41:58.155+00:00'), error: null }
      if (table === 'workspaces' && ops.some(o => o.name === 'update')) return { data: [], error: null }
      return { data: null, error: null }
    }
    const res = await patch({ brandColour: '#222222' })
    expect(res.status).toBe(409)
    const casCall = calls.find(c => c.table === 'workspaces' && c.ops.some(o => o.name === 'update'))!
    expect(casCall.ops.some(o => o.name === 'eq' && o.args[0] === 'updated_at' && o.args[1] === '2026-09-29T08:41:58.155+00:00')).toBe(true)
  })
})
