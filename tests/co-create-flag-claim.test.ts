import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for the CO logic independent re-pass: POST /api/co accepted a client-supplied
// flagId after checking only that the flag belonged to the project/workspace — never that it was
// still open and unlinked. A second CO could therefore share a flag already owned by a live CO, and
// every lifecycle writer that reverts/resolves "its" flag (keyed on flag id alone) rewrote the
// first CO's flag. The route now refuses a claimed flag and claims an open one atomically.

let db: Record<string, any[]>
let insertFails = false
let claimLosesRace = false

// Tiny in-memory query builder: eq / is / in filters, select / insert / update, single / maybeSingle.
function table(name: string) {
  let filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'insert' | 'update' = 'select'
  let payload: any = null
  let wantSingle = false
  const b: any = {
    select: () => b,
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return b },
    in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return b },
    limit: () => b,
    single: () => { wantSingle = true; return b },
    maybeSingle: () => { wantSingle = true; return b },
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    then: (resolve: any, reject: any) => {
      let result: any
      const rows = (db[name] = db[name] || [])
      if (op === 'insert') {
        if (name === 'change_orders' && insertFails) result = { data: null, error: { message: 'boom' } }
        else { const row = { id: `co-${rows.length + 1}`, ...payload }; rows.push(row); result = { data: row, error: null } }
      } else if (op === 'update') {
        if (name === 'guardian_flags' && claimLosesRace && payload.status === 'converted_to_co') {
          result = { data: [], error: null }
        } else {
          const hit = rows.filter(r => filters.every(f => f(r)))
          hit.forEach(r => Object.assign(r, payload))
          result = { data: hit.map(r => ({ id: r.id })), error: null }
        }
      } else {
        const hit = rows.filter(r => filters.every(f => f(r)))
        result = wantSingle ? { data: hit[0] ?? null, error: null } : { data: hit, error: null }
      }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => table(t) }) }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', workspaceId: 'ws-1', email: 'a@b.c', name: 'A' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => {}) }))

import { POST } from '@/app/api/co/route'

const req = (body: any) => ({ json: async () => body }) as any
const baseBody = { projectId: 'p1', title: 'Extra scope', lineItems: [{ description: 'Work', quantity: 1, rate: 100 }] }

beforeEach(() => {
  insertFails = false
  claimLosesRace = false
  db = {
    projects: [{ id: 'p1', workspace_id: 'ws-1', status: 'Active', deleted_at: null }],
    sow_documents: [{ id: 's1', project_id: 'p1', status: 'signed' }],
    change_orders: [],
    guardian_flags: [
      { id: 'f-open', project_id: 'p1', workspace_id: 'ws-1', status: 'open', change_order_id: null },
      { id: 'f-taken', project_id: 'p1', workspace_id: 'ws-1', status: 'converted_to_co', change_order_id: 'co-existing' },
    ],
  }
})

describe('POST /api/co — flagId handling', () => {
  it('refuses a flag already owned by another change order and creates nothing', async () => {
    const res: any = await POST(req({ ...baseBody, flagId: 'f-taken' }))
    expect(res.status).toBe(409)
    expect(db.change_orders).toHaveLength(0)
    expect(db.guardian_flags.find(f => f.id === 'f-taken')).toMatchObject({ status: 'converted_to_co', change_order_id: 'co-existing' })
  })

  it('claims an open flag atomically and links it to the new CO', async () => {
    const res: any = await POST(req({ ...baseBody, flagId: 'f-open' }))
    expect(res.status).toBe(200)
    const { coId } = await res.json()
    expect(db.change_orders[0].flag_id).toBe('f-open')
    expect(db.guardian_flags.find(f => f.id === 'f-open')).toMatchObject({ status: 'converted_to_co', change_order_id: coId })
  })

  it('refuses when a concurrent request wins the claim between the read and the write', async () => {
    claimLosesRace = true
    const res: any = await POST(req({ ...baseBody, flagId: 'f-open' }))
    expect(res.status).toBe(409)
    expect(db.change_orders).toHaveLength(0)
  })

  it('releases the claim if the CO insert fails, so the flag is not stranded', async () => {
    insertFails = true
    const res: any = await POST(req({ ...baseBody, flagId: 'f-open' }))
    expect(res.status).toBe(500)
    expect(db.guardian_flags.find(f => f.id === 'f-open')).toMatchObject({ status: 'open', change_order_id: null })
  })

  it('still creates a CO with no flag exactly as before', async () => {
    const res: any = await POST(req(baseBody))
    expect(res.status).toBe(200)
    expect(db.change_orders[0].flag_id).toBeNull()
  })
})
