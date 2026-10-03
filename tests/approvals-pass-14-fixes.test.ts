// tests/approvals-pass-14-fixes.test.ts
//
// Approvals audit (section 11), pass 14:
//   F1 a failed approver / project-members lookup read as "nobody to notify" (false "no reachable approver" alert, a
//      silently lost approver notification, a gate 409 blaming Settings) — now thrown;
//   F2 requests healed lazily (gate / GET /api/approvals) left no audit row, and a failed auto-send left none either;
//   F3 cancel / reassign / retry-send / approvers answered 404 for a failed read;
//   F4 reassign's step-clock reset was unchecked;
//   F5 cancel / reassign "no action needed" notices went to the requester and to the new assignee;
//   F6 cancel claimed "editable draft again" for a document that may already have been sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const state = { insertResult: true as boolean, auditRows: [] as any[], notified: [] as any[], roleMembers: [] as any[] }

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: vi.fn(async () => true) }))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: vi.fn(async () => ({ ok: true })),
  sendApprovalDecisionEmail: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/utils/audit', () => ({
  logAudit: vi.fn(async (_s: any, p: any) => { state.auditRows.push(p); return true }),
  insertAuditRow: vi.fn(async (_s: any, r: any) => { state.auditRows.push(r); return true }),
}))
vi.mock('@/lib/utils/notify', () => ({
  insertNotificationRows: vi.fn(async (_s: any, rows: any[]) => { state.notified.push(...rows); return state.insertResult }),
}))
vi.mock('@/lib/utils/permissions-query', () => ({
  getMembersWithRole: vi.fn(async () => state.roleMembers),
  filterByNotificationPreference: vi.fn(async (_s: any, _w: string, _e: string, r: any[]) => r),
  filterToProjectAccess: vi.fn(async (_s: any, _p: any, r: any[]) => r),
}))

import { sendApprovalReminder, healStuckSends, cancelApprovalRequest, reassignApprovalStep } from '@/lib/approvals/engine'

type Res = { data: any; error: any }
const ok = (data: any): Res => ({ data, error: null })
const boom: Res = { data: null, error: { message: 'connection reset' } }

function fake(tables: Record<string, Res | Res[]>, rpc: Res = ok(true)) {
  const counters: Record<string, number> = {}
  return {
    rpc: vi.fn(() => Promise.resolve(rpc)),
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

beforeEach(() => { state.insertResult = true; state.auditRows = []; state.notified = []; state.roleMembers = [] })

describe('F1 — a failed approver lookup is an error, not "no recipients"', () => {
  const req = { id: 'r1', workspace_id: 'w1', document_type: 'sow', current_step: 1, total_steps: 1, context: { title: 'T' },
    requested_by: 'u1', project_id: 'p1', allow_self_approval: false, require_distinct_approvers: false }
  const userStep = { step_order: 1, approver_role_id: null, approver_user_id: 'u2' }
  const requester = { id: 'u1', name: 'A', email: 'a@x.test' }

  it('the reminder throws (a cron row error) when the named approver read fails', async () => {
    const svc = fake({ approval_requests: ok(req), approval_steps: ok(userStep), users: ok(requester), workspace_members: boom })
    await expect(sendApprovalReminder(svc, 'r1')).rejects.toThrow(/approver lookup failed/)
  })
  it("still reports 'no_recipients' when the named approver genuinely is not an active member", async () => {
    const svc = fake({ approval_requests: ok(req), approval_steps: ok(userStep), users: ok(requester), workspace_members: ok(null) })
    expect(await sendApprovalReminder(svc, 'r1')).toBe('no_recipients')
  })
  it('the engine and eligibility ask for strict project-access lookups', () => {
    const engine = readFileSync('lib/approvals/engine.ts', 'utf8')
    const elig = readFileSync('lib/approvals/eligibility.ts', 'utf8')
    expect(elig).toMatch(/filterToProjectAccess\(service, projectId, people, permissionMap, \{ strict: true \}\)/)
    expect((engine.match(/\{ strict: true \}/g) || []).length).toBeGreaterThanOrEqual(3)
  })
  it('filterToProjectAccess throws when strict and returns closed (logged) otherwise', async () => {
    const real = await vi.importActual<typeof import('@/lib/utils/permissions-query')>('@/lib/utils/permissions-query')
    const svc = fake({ project_members_active: boom })
    await expect(real.filterToProjectAccess(svc, 'p1', [{ id: 'u2' }], new Map(), { strict: true })).rejects.toThrow(/project members/)
    expect(await real.filterToProjectAccess(svc, 'p1', [{ id: 'u2' }], new Map())).toEqual([])
  })
})

describe('F2 — lazily healed requests are audited; a failed auto-send leaves a trail', () => {
  const stuck = [{ id: 'r1', workspace_id: 'w1', requested_by: 'u1', project_id: 'p1', document_type: 'sow', context: { title: 'T' } }]
  it('writes approval.send_failed_stale only when auditHealed is set', async () => {
    await healStuckSends(fake({ approval_requests: ok(stuck) }), 2, 'w1', { auditHealed: true })
    expect(state.auditRows.map(r => r.event_type)).toEqual(['approval.send_failed_stale'])
    state.auditRows = []
    await healStuckSends(fake({ approval_requests: ok(stuck) }), 10, undefined, { strict: true })
    expect(state.auditRows).toEqual([])
  })
  it('the gate and the list route opt in; the cron (which writes its own row) does not', () => {
    expect(readFileSync('app/api/approvals/route.ts', 'utf8')).toMatch(/session\.workspaceId, \{ auditHealed: true \}/)
    expect(readFileSync('lib/approvals/engine.ts', 'utf8')).toMatch(/workspaceId, \{ auditHealed: true \}/)
    expect(readFileSync('app/api/cron/approval-stall/route.ts', 'utf8')).not.toContain('auditHealed')
  })
  it('recordApprovalDecision and retryFailedSend log the failure events', () => {
    const engine = readFileSync('lib/approvals/engine.ts', 'utf8')
    expect(engine).toContain("eventType: 'approval.send_failed'")
    expect(engine).toContain("eventType: 'approval.send_retry_failed'")
  })
})

describe('F3 — request lookups in the action routes surface a read failure', () => {
  for (const route of ['cancel', 'reassign', 'retry-send', 'approvers']) {
    it(`${route} no longer maps a failed read to 404`, () => {
      const src = readFileSync(`app/api/approvals/[id]/${route}/route.ts`, 'utf8')
      expect(src).not.toMatch(/^[^/\n]*\.single\(\)/m)
      expect(src).toContain('if (reqErr)')
    })
  }
  it('approvers reports a failed roles read', () => {
    expect(readFileSync('app/api/approvals/[id]/approvers/route.ts', 'utf8')).toContain('if (rolesErr)')
  })
})

describe('F4/F5 — reassign', () => {
  const request = { id: 'r1', project_id: 'p1', document_type: 'sow', document_id: 'd1', requested_by: 'req', status: 'pending',
    current_step: 1, total_steps: 1, context: { title: 'T' }, allow_self_approval: false, require_distinct_approvers: false, sending_started_at: null }
  const step = { id: 's1', step_order: 1, approver_role_id: 'roleOld', approver_user_id: null, status: 'pending' }
  const target = { userId: 'newUser' }
  const actor = { id: 'admin', name: 'Admin', email: 'a@x.test' }
  const member = (id: string) => ({ user_id: id, role_id: 'x', effective_permissions: { APPROVE_DOCUMENTS: true }, users: { id, name: id, email: `${id}@x.test` } })

  it('retries the step-clock reset once and keeps going when it keeps failing', async () => {
    const updates: Res[] = []
    const svc: any = fake({
      approval_requests: [ok(request), boom, boom],
      approval_steps: [ok(step), ok({ id: 's1' })],
      workspace_members: ok([member('newUser')]),
      users: ok(null),
    })
    state.roleMembers = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await reassignApprovalStep(svc, { requestId: 'r1', workspaceId: 'w1', actor, target })
    expect(r.ok).toBe(true)
    expect(err.mock.calls.filter(c => String(c[0]).includes('could not reset the step clock')).length).toBe(2)
    err.mockRestore()
    void updates
  })
  it('does not send "reassigned away" to the requester or to the new assignee', async () => {
    state.roleMembers = [
      { id: 'req', name: 'R', email: 'r@x.test' }, { id: 'newUser', name: 'N', email: 'n@x.test' }, { id: 'old', name: 'O', email: 'o@x.test' },
    ]
    const svc: any = fake({
      approval_requests: ok(request), approval_steps: [ok(step), ok({ id: 's1' })],
      workspace_members: ok([member('newUser')]), users: ok(null),
    })
    await reassignApprovalStep(svc, { requestId: 'r1', workspaceId: 'w1', actor, target })
    const away = state.notified.filter(n => n.type === 'approval_reassigned').map(n => n.recipient_id)
    expect(away).toEqual(['old'])
  })
})

describe('F5 — cancel does not notify the requester about their own step', () => {
  it('drops the requester from the pending-step heads-up', async () => {
    state.roleMembers = [{ id: 'req', name: 'R', email: 'r@x.test' }, { id: 'appr', name: 'A', email: 'a@x.test' }]
    const request = { id: 'r1', project_id: 'p1', current_step: 1, context: { title: 'T' }, status: 'pending', requested_by: 'req', sending_started_at: null }
    const svc: any = fake({
      approval_requests: [ok([request]), ok({ id: 'r1' })],
      approval_steps: ok({ approver_role_id: 'role1', approver_user_id: null }),
    })
    const r = await cancelApprovalRequest(svc, {
      documentType: 'sow', documentId: 'd1', workspaceId: 'w1', actorId: 'admin', actorEmail: 'a@x.test', actorName: 'Admin',
    })
    expect(r.cancelled).toBe(true)
    const stepHeadsUp = state.notified.filter(n => n.entity_type === 'project').map(n => n.recipient_id)
    expect(stepHeadsUp).toEqual(['appr'])
    // …and the requester still gets their own dedicated notice (actor is someone else)
    expect(state.notified.some(n => n.recipient_id === 'req' && n.entity_type === 'approval_request')).toBe(true)
  })
})

describe('F6 — the draft claim', () => {
  it('the cancel route only claims "editable draft" when the document is still a draft', () => {
    const src = readFileSync('app/api/approvals/[id]/cancel/route.ts', 'utf8')
    expect(src).toMatch(/returnedToDraft = !docErr && doc\?\.status === 'draft'/)
    expect(src).toMatch(/^\s+returnedToDraft,$/m)
  })
  it('the client confirm text hedges for an approved-not-sent request', () => {
    expect(readFileSync('components/approvals/ApprovalsClient.tsx', 'utf8')).toContain('if it already did, it stays as sent')
  })
})
