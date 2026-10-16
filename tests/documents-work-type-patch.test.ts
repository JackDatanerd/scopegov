import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Migration 162 — a retainer's kind of work (projects.work_type) through PATCH /api/projects/[id].

type Result = { data: any; error: any }
const ok = (data: any): Result => ({ data, error: null })
const fail = (): Result => ({ data: null, error: { message: 'connection reset', code: '08006' } })

const state = vi.hoisted(() => ({
  script: {} as Record<string, any[]>,
  calls: [] as Array<{ table: string; op: string }>,
  session: null as any,
  updates: [] as any[],
}))

function builder(table: string, result: Result) {
  const b: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit', 'range', 'gt', 'lt', 'filter']) b[m] = () => b
  for (const m of ['update', 'delete', 'insert', 'upsert']) b[m] = (payload?: any) => { state.calls.push({ table, op: m }); if (m === 'update' && table === 'projects') state.updates.push(payload); return b }
  b.maybeSingle = () => b
  b.single = () => b
  b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q = state.script[table]
      const next = q && q.length ? q.shift() : ok(null)
      return builder(table, next)
    },
    rpc: async () => ok(null),
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => state.session,
  getSessionStrict: async () => state.session,
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {}, insertAuditRow: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyUsers: async () => {} }))
vi.mock('@/lib/approvals/engine', () => ({
  getPendingApprovalForDocument: async () => null, cancelApprovalRequest: async () => ({ cancelled: true }),
  projectApprovalSendInFlight: async () => false, SEND_IN_FLIGHT_MESSAGE: 'in flight',
}))
vi.mock('@/lib/utils/project-limit', () => ({
  wouldExceedLimit: async () => false, isOverLimit: async () => false, isProjectBeyondLimit: async () => false,
  projectLimitMessage: () => 'limit',
}))

const PID = '11111111-1111-1111-1111-111111111111'
const params = { params: Promise.resolve({ id: PID }) }
const req = (body?: any) => ({ json: async () => body ?? {}, url: `http://x/api/projects/${PID}` }) as any

beforeEach(() => {
  state.script = {}
  state.calls = []
  state.updates = []
  state.session = { id: 'u1', workspaceId: 'w1', name: 'Mas', email: 'm@x.com', planTier: 'pro' }
})

const base = { id: PID, name: 'P', disc: null, status: 'Active', stall_reason: null, client_id: 'c1', currency: 'USD', contract_value: 100,
  start_date: null, internal_ref: null, retainer_duration_months: null, sow_documents: [] as any[] }

async function patch(project: any, body: any, fresh: any[] = project.sow_documents) {
  const { PATCH } = await import('@/app/api/projects/[id]/route')
  state.script.projects = [ok(project), ok({ sow_documents: fresh }), ok({ id: PID })]
  return PATCH(req(body), params)
}

describe('PATCH /api/projects/[id] — kind of work on a retainer', () => {
  it('a Marketing project switched to a retainer becomes a Marketing retainer', async () => {
    const res = await patch({ ...base, type: 'marketing', work_type: null }, { type: 'retainer' })
    expect(res.status).toBeLessThan(400)
    expect(state.updates[0]).toMatchObject({ type: 'retainer', work_type: 'marketing' })
  })
  it('a request that names the kind of work wins over what the project was', async () => {
    await patch({ ...base, type: 'marketing', work_type: null }, { type: 'retainer', workType: 'video' })
    expect(state.updates[0]).toMatchObject({ type: 'retainer', work_type: 'video' })
  })
  it('switching out of a retainer clears the kind of work', async () => {
    await patch({ ...base, type: 'retainer', work_type: 'marketing' }, { type: 'web' })
    expect(state.updates[0]).toMatchObject({ type: 'web', work_type: null })
  })
  it('an existing retainer can have its kind of work set while no SOW exists', async () => {
    const res = await patch({ ...base, type: 'retainer', work_type: null }, { workType: 'video' })
    expect(res.status).toBeLessThan(400)
    expect(state.updates[0]).toMatchObject({ work_type: 'video' })
  })
  it('a retainer is not a kind of work, and nonsense is refused', async () => {
    expect((await patch({ ...base, type: 'retainer' }, { workType: 'retainer' })).status).toBe(400)
    expect((await patch({ ...base, type: 'retainer' }, { workType: 'nonsense' })).status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })
  it('a signed SOW locks it (it feeds the SOW\'s standard terms)', async () => {
    const sows = [{ id: 's1', status: 'signed' }]
    const res = await patch({ ...base, type: 'retainer', work_type: 'marketing', sow_documents: sows }, { workType: 'video' }, sows)
    expect(res.status).toBe(409)
    expect(state.updates).toHaveLength(0)
  })
  it('a kind of work sent for a project that is not a retainer is ignored', async () => {
    await patch({ ...base, type: 'web', work_type: null }, { name: 'Renamed', workType: 'video' })
    expect(state.updates[0]).not.toHaveProperty('work_type')
  })
})
