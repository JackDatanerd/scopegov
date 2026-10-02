// tests/approvals-pass-11-fixes.test.ts
//
// Approvals audit (section 11): the last unchecked supabase-js `error`s in the approval paths. supabase-js resolves to
// { data: null, error } instead of throwing, so a transient failure read as "no row":
//   B1 cancelApprovalRequest answered "nothing to cancel" -> callers destroyed a document with its request still live;
//   B2 recordApprovalDecision / retryFailedSend / reassignApprovalStep / sendApprovalReminder answered 404 / "already
//      decided" / 'not_found', and the post-commit requester + next-step reads silently skipped notifications or
//      parked a final approval as "not sent" for a false reason;
//   B3 the list/detail routes' role + project-access lookups silently emptied a member's queue;
//   B4 /reassign passed non-uuid ids to Postgres (500 instead of 400);
//   B5 a numeric-string expiresInDays was dropped by the approval gate but honoured by the direct send.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: vi.fn(async () => true) }))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: vi.fn(async () => ({ ok: true })),
  sendApprovalDecisionEmail: vi.fn(async () => ({ ok: true })),
}))

import {
  cancelApprovalRequest, recordApprovalDecision, retryFailedSend, reassignApprovalStep, sendApprovalReminder,
  evaluateApprovalGate,
} from '@/lib/approvals/engine'
import { allowedProjectIdsFor } from '@/lib/approvals/list'
import { isUuid } from '@/lib/approvals/workflow-input'

type Res = { data: any; error: any }
const ok = (data: any): Res => ({ data, error: null })
const boom: Res = { data: null, error: { message: 'connection reset' } }

function fake(tables: Record<string, Res | Res[]>, rpcResult: Res = ok(null)) {
  const counters: Record<string, number> = {}
  const calls: Record<string, number> = {}
  const inserts: Record<string, any[]> = {}
  const rpc = vi.fn(() => Promise.resolve(rpcResult))
  const svc: any = {
    calls, inserts, rpc,
    from(table: string) {
      calls[table] = (calls[table] ?? 0) + 1
      const cfg = tables[table] ?? ok([])
      const idx = (counters[table] = (counters[table] ?? -1) + 1)
      const res: Res = Array.isArray(cfg) ? cfg[Math.min(idx, cfg.length - 1)] : cfg
      const q: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'not', 'is', 'lt', 'gte', 'order', 'limit', 'update', 'delete'])
        q[m] = () => q
      q.insert = (row: any) => { (inserts[table] ||= []).push(row); return q }
      q.maybeSingle = () => Promise.resolve(res)
      q.single = () => Promise.resolve(res)
      q.then = (a: any, b: any) => Promise.resolve(res).then(a, b)
      return q
    },
  }
  return svc
}

const actor: any = { id: 'u2', name: 'B', email: 'b@x.test', workspaceId: 'w1', permissions: ['APPROVE_DOCUMENTS'] }
const request = {
  id: 'r1', workspace_id: 'w1', workflow_id: 'wf1', document_type: 'sow', document_id: 'd1', project_id: null,
  requested_by: 'u1', status: 'pending', current_step: 1, total_steps: 2, context: { title: 'T' },
  allow_self_approval: false, require_distinct_approvers: false,
}
const step1 = { id: 's1', step_order: 1, approver_role_id: null, approver_user_id: 'u2', status: 'pending' }
const step2 = { id: 's2', step_order: 2, approver_role_id: null, approver_user_id: 'u3', status: 'pending' }
const requester = { id: 'u1', name: 'A', email: 'a@x.test' }
const decide = (svc: any) => recordApprovalDecision(svc, { requestId: 'r1', actor, decision: 'approved' })

describe('B1 — cancelApprovalRequest no longer fails open', () => {
  const cancelParams: any = { documentType: 'co', documentId: 'd1', workspaceId: 'w1', actorId: 'u1', actorEmail: 'a@x.test', actorName: 'A' }
  it('throws when the lookup of the live request fails (instead of "nothing to cancel")', async () => {
    await expect(cancelApprovalRequest(fake({ approval_requests: boom }), cancelParams)).rejects.toThrow(/look up the approval request/)
  })
  it('throws when the cancel write itself fails', async () => {
    const row = { id: 'r1', project_id: 'p1', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }
    await expect(cancelApprovalRequest(fake({ approval_requests: [ok([row]), boom] }), cancelParams)).rejects.toThrow(/could not cancel/)
  })
  it('still answers "nothing to cancel" when the read is fine and there is no live request', async () => {
    expect(await cancelApprovalRequest(fake({ approval_requests: ok([]) }), cancelParams)).toEqual({ cancelled: false, blockedBySend: false })
  })
  it('still cancels a live request', async () => {
    const row = { id: 'r1', project_id: 'p1', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }
    const r = await cancelApprovalRequest(fake({ approval_requests: [ok([row]), ok({ id: 'r1' })], approval_steps: ok(null) }), cancelParams)
    expect(r).toEqual({ cancelled: true, blockedBySend: false })
  })
})

describe('B2 — recordApprovalDecision reads fail before anything is committed', () => {
  it('a failed request read is a retryable 500, not a 404', async () => {
    const svc = fake({ approval_requests: boom })
    expect(await decide(svc)).toMatchObject({ ok: false, status: 500 })
    expect(svc.rpc).not.toHaveBeenCalled()
  })
  it('a failed step read is a retryable 500, not "already decided"', async () => {
    const svc = fake({ approval_requests: ok(request), approval_steps: boom })
    expect(await decide(svc)).toMatchObject({ ok: false, status: 500 })
    expect(svc.rpc).not.toHaveBeenCalled()
  })
  it('a failed requester read refuses BEFORE decide_approval_step runs (nothing committed)', async () => {
    const svc = fake({ approval_requests: ok(request), approval_steps: ok([step1, step2]), users: boom })
    expect(await decide(svc)).toMatchObject({ ok: false, status: 500 })
    expect(svc.rpc).not.toHaveBeenCalled()
  })
  it('a missing request is still a 404 and a decided one still a 400', async () => {
    expect(await decide(fake({ approval_requests: ok(null) }))).toMatchObject({ ok: false, status: 404 })
    expect(await decide(fake({ approval_requests: ok({ ...request, status: 'approved' }) }))).toMatchObject({ ok: false, status: 400 })
  })
  it('reads the next step together with the current one — no read after the decision commits', async () => {
    const svc = fake({ approval_requests: ok(request), approval_steps: ok([step1, step2]), users: ok(requester) }, ok('advanced'))
    expect(await decide(svc)).toEqual({ ok: true, status: 'pending' })
    expect(svc.rpc).toHaveBeenCalledTimes(1)
    expect(svc.calls['approval_steps']).toBe(1)
  })
  it('a rejection still records and reports', async () => {
    const svc = fake({ approval_requests: ok(request), approval_steps: ok([step1, step2]), users: ok(requester) }, ok('rejected'))
    expect(await recordApprovalDecision(svc, { requestId: 'r1', actor, decision: 'rejected', note: 'no' })).toEqual({ ok: true, status: 'rejected' })
  })
})

describe('B2 — retry / reassign / reminder reads', () => {
  const retryParams = { requestId: 'r1', workspaceId: 'w1', actor: { id: 'u1', email: 'a@x.test', name: 'A' } }
  const failedReq = { id: 'r1', document_type: 'sow', document_id: 'd1', project_id: null, context: {}, status: 'approved', send_failed_at: 'x', requested_by: 'u1' }
  it('retry: a failed request read is not "not found"', async () => {
    const r = await retryFailedSend(fake({ approval_requests: boom }), retryParams)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/try again/) })
  })
  it('retry: a failed requester read is not "no longer has an account"', async () => {
    const r: any = await retryFailedSend(fake({ approval_requests: ok(failedReq), users: boom }), retryParams)
    expect(r.ok).toBe(false)
    expect(r.error).not.toMatch(/no longer has an account/)
  })
  it('retry: a failed claim write does not read as "a retry is already in progress"', async () => {
    const r: any = await retryFailedSend(fake({ approval_requests: [ok(failedReq), boom], users: ok(requester) }), retryParams)
    expect(r.ok).toBe(false)
    expect(r.error).not.toMatch(/already in progress/)
  })
  const reassignParams: any = { requestId: 'r1', workspaceId: 'w1', actor: { id: 'a1', name: 'Ad', email: 'ad@x.test' }, target: { userId: 'u9' } }
  it('reassign: failed request / step reads are 500s', async () => {
    expect(await reassignApprovalStep(fake({ approval_requests: boom }), reassignParams)).toMatchObject({ ok: false, status: 500 })
    expect(await reassignApprovalStep(fake({ approval_requests: ok(request), approval_steps: boom }), reassignParams)).toMatchObject({ ok: false, status: 500 })
  })
  it('reminder: failed reads throw (a cron row error), they do not read as not_found', async () => {
    await expect(sendApprovalReminder(fake({ approval_requests: boom }), 'r1')).rejects.toThrow(/request lookup failed/)
    await expect(sendApprovalReminder(fake({ approval_requests: ok(request), approval_steps: boom }), 'r1')).rejects.toThrow(/step lookup failed/)
    await expect(sendApprovalReminder(fake({ approval_requests: ok(request), approval_steps: ok(step1), users: boom }), 'r1')).rejects.toThrow(/requester lookup failed/)
  })
  it('reminder: a genuinely missing request is still not_found', async () => {
    expect(await sendApprovalReminder(fake({ approval_requests: ok(null) }), 'r1')).toBe('not_found')
  })
})

describe('B3 — project-access lookup', () => {
  it('a failed read throws instead of producing an empty "can see nothing" set', async () => {
    const session: any = { id: 'u1', workspaceId: 'w1', permissions: [] }
    await expect(allowedProjectIdsFor(fake({ project_members_active: boom }), session)).rejects.toThrow(/project access/)
  })
  it('returns the member\'s projects, and null for VIEW_ALL_PROJECTS', async () => {
    const session: any = { id: 'u1', workspaceId: 'w1', permissions: [] }
    const set = await allowedProjectIdsFor(fake({ project_members_active: ok([{ project_id: 'p1' }]) }), session)
    expect([...(set as Set<string>)]).toEqual(['p1'])
    expect(await allowedProjectIdsFor(fake({}), { ...session, permissions: ['VIEW_ALL_PROJECTS'] })).toBeNull()
  })
})

describe('B4 — isUuid', () => {
  it('accepts a uuid and rejects everything else', () => {
    expect(isUuid('3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b')).toBe(true)
    for (const bad of ['', 'abc', '3f2b8c1e', null, undefined, 42, {}]) expect(isUuid(bad)).toBe(false)
  })
})

describe('B5 — expiresInDays through the approval gate', () => {
  const holder = { user_id: 'u9', role_id: null, effective_permissions: { APPROVE_DOCUMENTS: true, VIEW_ALL_PROJECTS: true }, users: { id: 'u9', name: 'N', email: 'n@x.test' } }
  async function stored(expiresInDays: any) {
    const svc = fake({
      approval_requests: [ok([]), ok({ id: 'rNew' })],
      approval_workflows: ok([{ id: 'wf', threshold_amount: null, threshold_currency: null }]),
      approval_workflow_steps: ok([{ step_order: 1, approver_role_id: null, approver_user_id: 'u9' }]),
      workspace_members: ok([holder]),
      approval_steps: ok([]),
    })
    const gate = await evaluateApprovalGate(svc, {
      workspaceId: 'w1', documentType: 'sow', documentId: 'd1', projectId: 'p1', projectName: 'Acme', amount: 100,
      currency: 'USD', documentTitle: 'SOW', requestedBy: { id: 'u1', name: 'A', email: 'a@x.test' }, expiresInDays,
    })
    expect(gate).toMatchObject({ requiresApproval: true, approvalRequestId: 'rNew' })
    return svc.inserts['approval_requests'][0].context.expires_in_days
  }
  it('keeps a number, a numeric string and truncates a fraction', async () => {
    expect(await stored(14)).toBe(14)
    expect(await stored('14')).toBe(14)
    expect(await stored(7.9)).toBe(7)
  })
  it('stores null (default expiry) for junk, zero, negatives and absence', async () => {
    for (const v of ['abc', 0, -3, undefined, null, '']) expect(await stored(v)).toBeNull()
  })
})
