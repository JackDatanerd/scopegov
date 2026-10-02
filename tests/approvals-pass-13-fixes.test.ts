// tests/approvals-pass-13-fixes.test.ts
//
// Approvals audit (section 11), pass 13 — the last places a transient failure was misreported:
//   F1 approval-workflows POST / PATCH / DELETE ignored the error on their lookups and guard counts (a 404 / 409 / 400
//      for what was a retryable failure);
//   F2 retry-send answered 400 for everything (incl. "a retry is already in progress" and a failed lookup);
//   F3 a reminder whose bell insert failed (database error) and reached nobody read as "no reachable approver";
//   F4 a requester who lost access to the project could not cancel their own request.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const state = { insertResult: true as boolean, roleMembers: [] as any[] }

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: vi.fn(async () => true) }))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: vi.fn(async () => ({ ok: false, error: 'bounced' })),
  sendApprovalDecisionEmail: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/utils/notify', () => ({ insertNotificationRows: vi.fn(async () => state.insertResult) }))
vi.mock('@/lib/utils/permissions-query', () => ({
  // in-app channel only, so a failed bell insert leaves nobody reached
  getMembersWithRole: vi.fn(async (_s: any, _w: string, _r: string, _l: number, _p: any, _e: any, channel: string) =>
    channel === 'in_app' ? state.roleMembers : []),
  filterByNotificationPreference: vi.fn(async (_s: any, _w: string, _e: string, r: any[]) => r),
  filterToProjectAccess: vi.fn(async (_s: any, _p: any, r: any[]) => r),
}))

import { retryFailedSend, sendApprovalReminder } from '@/lib/approvals/engine'

type Res = { data: any; error: any }
const ok = (data: any): Res => ({ data, error: null })
const boom: Res = { data: null, error: { message: 'connection reset' } }

function fake(tables: Record<string, Res | Res[]>) {
  const counters: Record<string, number> = {}
  return {
    rpc: vi.fn(() => Promise.resolve(ok(null))),
    from(table: string) {
      const cfg = tables[table] ?? ok([])
      const idx = (counters[table] = (counters[table] ?? -1) + 1)
      const res: Res = Array.isArray(cfg) ? cfg[Math.min(idx, cfg.length - 1)] : cfg
      const q: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'not', 'is', 'lt', 'gte', 'order', 'limit', 'update', 'delete', 'insert'])
        q[m] = () => q
      q.maybeSingle = () => Promise.resolve(res)
      q.single = () => Promise.resolve(res)
      q.then = (a: any, b: any) => Promise.resolve(res).then(a, b)
      return q
    },
  } as any
}

const retryParams = { requestId: 'r1', workspaceId: 'w1', actor: { id: 'u1', email: 'a@x.test', name: 'A' } }
const failedReq = { id: 'r1', document_type: 'sow', document_id: 'd1', project_id: null, context: {}, status: 'approved', send_failed_at: 'x', requested_by: 'u1' }
const requester = { id: 'u1', name: 'A', email: 'a@x.test' }

describe('F2 — retryFailedSend reports the right status', () => {
  it('404 for a missing request', async () => {
    expect(await retryFailedSend(fake({ approval_requests: ok(null) }), retryParams)).toMatchObject({ ok: false, status: 404 })
  })
  it('400 when there is nothing to retry', async () => {
    expect(await retryFailedSend(fake({ approval_requests: ok({ ...failedReq, send_failed_at: null }) }), retryParams))
      .toMatchObject({ ok: false, status: 400 })
  })
  it('500 for a failed request / requester / claim read', async () => {
    expect(await retryFailedSend(fake({ approval_requests: boom }), retryParams)).toMatchObject({ ok: false, status: 500 })
    expect(await retryFailedSend(fake({ approval_requests: ok(failedReq), users: boom }), retryParams)).toMatchObject({ ok: false, status: 500 })
    expect(await retryFailedSend(fake({ approval_requests: [ok(failedReq), boom], users: ok(requester) }), retryParams))
      .toMatchObject({ ok: false, status: 500 })
  })
  it('409 when another retry holds the claim', async () => {
    const r = await retryFailedSend(fake({ approval_requests: [ok(failedReq), ok([])], users: ok(requester) }), retryParams)
    expect(r).toMatchObject({ ok: false, status: 409 })
  })
  it('the route hands the engine status to the client', () => {
    const src = readFileSync('app/api/approvals/[id]/retry-send/route.ts', 'utf8')
    expect(src).toMatch(/status: result\.status/)
    expect(src).not.toMatch(/\{ error: result\.error \}, \{ status: 400 \}/)
  })
})

describe('F3 — a failed bell insert is not "no reachable approver"', () => {
  const req = { id: 'r1', workspace_id: 'w1', document_type: 'sow', current_step: 1, total_steps: 1, context: { title: 'T' },
    requested_by: 'u1', project_id: 'p1', allow_self_approval: false, require_distinct_approvers: false }
  const step = { step_order: 1, approver_role_id: 'role1', approver_user_id: null }
  const svc = () => fake({ approval_requests: ok(req), approval_steps: ok(step), users: ok(requester) })
  beforeEach(() => { state.insertResult = true; state.roleMembers = [{ id: 'u2', name: 'B', email: 'b@x.test' }] })

  it('throws (a cron row error) when the insert failed and nothing else reached anyone', async () => {
    state.insertResult = false
    await expect(sendApprovalReminder(svc(), 'r1')).rejects.toThrow(/could not deliver/)
  })
  it("still reports 'sent' when the bell insert lands", async () => {
    expect(await sendApprovalReminder(svc(), 'r1')).toBe('sent')
  })
  it("still reports 'no_recipients' when there is genuinely nobody to notify", async () => {
    state.roleMembers = []
    expect(await sendApprovalReminder(svc(), 'r1')).toBe('no_recipients')
  })
})

describe('F1 — workflow routes surface lookup failures', () => {
  const post = readFileSync('app/api/approval-workflows/route.ts', 'utf8')
  const patch = readFileSync('app/api/approval-workflows/[id]/route.ts', 'utf8')
  it('POST checks the guard counts and the role / approver lookups', () => {
    for (const name of ['dupeCatchAllErr', 'dupeThresholdErr', 'roleRowsErr', 'memberRowsErr'])
      expect(post).toContain(`if (${name}`)
  })
  it('PATCH checks its workflow read, step count, guard counts and lookups', () => {
    for (const name of ['existingErr', 'stepCountErr', 'dupeCatchAllErr', 'dupeThresholdErr', 'roleRowsErr', 'memberRowsErr'])
      expect(patch).toContain(`if (${name}`)
  })
  it('PATCH / DELETE no longer use .single() for the existence read', () => {
    expect(patch).not.toMatch(/\.eq\('workspace_id', session\.workspaceId\)\.single\(\)/)
  })
})

describe('F4 — the requester can always cancel their own request', () => {
  it('the project-access check is only applied to someone other than the requester', () => {
    const src = readFileSync('app/api/approvals/[id]/cancel/route.ts', 'utf8')
    expect(src).toMatch(/req\.requested_by !== session\.id && !\(await canReadProject/)
  })
})
