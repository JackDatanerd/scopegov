// tests/cron-section17-round6-stall.test.ts
//
// B2 end to end: with the REAL healStuckSends (not mocked), a broken heal step must make the approval-stall cron
// fail loudly instead of reporting `healed: 0` with a green heartbeat.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, alerts: [] as any[], heartbeats: [] as any[], audits: [] as any[] }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string, r: any) => { h.heartbeats.push({ name, r }) } }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.audits.push(row); return h.audits.length > 0 && !(globalThis as any).__auditFail },
}))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => true }))

import { POST as approvalStall } from '@/app/api/cron/approval-stall/route'

const call = async () => { const res = await approvalStall({} as any); return { status: res.status, body: await res.json() } }
const stuck = { id: 'r1', workspace_id: 'w1', requested_by: 'u1', project_id: 'p1', document_type: 'sow', context: { title: 'T' }, status: 'pending', sending_started_at: '2020-01-01T00:00:00Z', updated_at: new Date().toISOString() }

beforeEach(() => {
  h.alerts.length = 0; h.heartbeats.length = 0; h.audits.length = 0; (globalThis as any).__auditFail = false
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B2 — approval-stall surfaces a broken heal step', () => {
  it('a failing candidate lookup fails the run: 500, ops alerted, NO green heartbeat', async () => {
    h.db = createFakeSupabase({ approval_requests: [stuck] }, { errors: [{ table: 'approval_requests', op: 'select' }] })
    const { status, body } = await call()
    expect(status).toBe(500)
    expect(body.ok).toBe(false)
    expect(JSON.stringify(body.errors)).toContain('heal stuck sends')
    expect(h.alerts.length).toBeGreaterThan(0)
    expect(h.heartbeats).toHaveLength(0)
  })

  it('a failing finalize RPC is a row error: the run still completes (heartbeat) but ops is alerted and nothing is counted healed', async () => {
    h.db = createFakeSupabase({ approval_requests: [stuck] }, { rpc: { finalize_approval_send: () => ({ data: null, error: { message: 'function public.finalize_approval_send does not exist' } }) } })
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.healed).toBe(0)
    expect(JSON.stringify(body.rowErrors)).toContain('heal stuck send r1')
    expect(h.alerts.length).toBeGreaterThan(0)
    expect(h.heartbeats).toHaveLength(1)
  })

  it('a heal whose audit row fails to write is a row error (the heal itself still counts)', async () => {
    h.db = createFakeSupabase({ approval_requests: [stuck] }, { rpc: { finalize_approval_send: () => ({ data: true, error: null }) } })
    ;(globalThis as any).__auditFail = true
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.healed).toBe(1)
    expect(JSON.stringify(body.rowErrors)).toContain('approval.send_failed_stale')
  })

  it('a healthy heal is clean: healed counted, no alerts, heartbeat recorded', async () => {
    h.db = createFakeSupabase({ approval_requests: [stuck] }, { rpc: { finalize_approval_send: () => ({ data: true, error: null }) } })
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.healed).toBe(1)
    expect(body.rowErrors).toBeUndefined()
    expect(h.alerts).toHaveLength(0)
    expect(h.heartbeats).toHaveLength(1)
  })
})
