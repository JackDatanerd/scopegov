// tests/approvals-fail-closed.test.ts
//
// Section-11 fresh pass (B1-B6): every read the approval engine's governance decisions rest on used to ignore its
// `error`. supabase-js never throws, so a transient failure read as "no data" — and "no data" meant "no workflow",
// "no lock", "nothing sending", "nobody approved earlier": the gate, the edit lock, the send-in-flight guard and the
// four-eyes check all failed OPEN. They now fail closed.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))

import {
  evaluateApprovalGate, getPendingApprovalForDocument, approvalSendInFlight, projectApprovalSendInFlight,
  recordApprovalDecision, reassignApprovalStep,
} from '@/lib/approvals/engine'

type Res = { data: any; error: any }
const ok = (data: any): Res => ({ data, error: null })
const boom: Res = { data: null, error: { message: 'connection reset' } }

// A chainable stand-in for the supabase-js query builder: each table resolves to a canned result.
function fake(tables: Record<string, Res | Res[]>) {
  const counters: Record<string, number> = {}
  return {
    from(table: string) {
      const cfg = tables[table] ?? ok([])
      const idx = (counters[table] = (counters[table] ?? -1) + 1)
      const res: Res = Array.isArray(cfg) ? cfg[Math.min(idx, cfg.length - 1)] : cfg
      const q: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'not', 'is', 'lt', 'gte', 'order', 'limit', 'insert', 'update', 'delete'])
        q[m] = () => q
      q.maybeSingle = () => Promise.resolve(res)
      q.single = () => Promise.resolve(res)
      q.then = (a: any, b: any) => Promise.resolve(res).then(a, b)
      return q
    },
    rpc: () => Promise.resolve(ok(null)),
  }
}

const gateParams: any = {
  workspaceId: 'w1', documentType: 'sow', documentId: 'd1', projectId: 'p1', amount: 50000, currency: 'USD',
  documentTitle: 'SOW v1', projectName: 'Acme', requestedBy: { id: 'u1', name: 'A', email: 'a@x.test' },
}

describe('evaluateApprovalGate fails closed', () => {
  it('a failed workflow read halts the send instead of reporting "no approval needed"', async () => {
    const svc = fake({ approval_requests: ok([]), approval_workflows: boom })
    await expect(evaluateApprovalGate(svc, gateParams)).rejects.toThrow(/send halted for safety/)
  })
  it('a failed lookup of the active request halts the send', async () => {
    const svc = fake({ approval_requests: boom, approval_workflows: ok([]) })
    await expect(evaluateApprovalGate(svc, gateParams)).rejects.toThrow(/active request/)
  })
  it('a failed workflow-steps read halts the send (not the misleading "no approvers configured" 409)', async () => {
    const svc = fake({
      approval_requests: ok([]),
      approval_workflows: ok([{ id: 'wf1', threshold_amount: null, threshold_currency: null, allow_self_approval: false, require_distinct_approvers: false, apply_to_other_currencies: false }]),
      approval_workflow_steps: boom,
    })
    await expect(evaluateApprovalGate(svc, gateParams)).rejects.toThrow(/workflow steps/)
  })
  it('still lets a document through when the read succeeded and no workflow applies', async () => {
    const svc = fake({ approval_requests: ok([]), approval_workflows: ok([]) })
    await expect(evaluateApprovalGate(svc, gateParams)).resolves.toEqual({ requiresApproval: false })
  })
})

describe('edit lock and in-flight guards fail closed', () => {
  it('getPendingApprovalForDocument throws rather than reporting "unlocked"', async () => {
    await expect(getPendingApprovalForDocument(fake({ approval_requests: boom }), 'sow', 'd1')).rejects.toThrow(/approval lock/)
  })
  it('getPendingApprovalForDocument still returns null when there is simply no request', async () => {
    await expect(getPendingApprovalForDocument(fake({ approval_requests: ok([]) }), 'sow', 'd1')).resolves.toBeNull()
  })
  it('approvalSendInFlight / projectApprovalSendInFlight throw rather than reporting "nothing sending"', async () => {
    await expect(approvalSendInFlight(fake({ approval_requests: boom }), 'w1', ['co'], 'd1')).rejects.toThrow(/in-flight/)
    await expect(projectApprovalSendInFlight(fake({ approval_requests: boom }), 'w1', 'p1')).rejects.toThrow(/in-flight/)
  })
  it('both guards still answer false when the read is fine and nothing is sending', async () => {
    expect(await approvalSendInFlight(fake({ approval_requests: ok([]) }), 'w1', ['co'], 'd1')).toBe(false)
    expect(await projectApprovalSendInFlight(fake({ approval_requests: ok([]) }), 'w1', 'p1')).toBe(false)
  })
})

describe('recordApprovalDecision four-eyes check fails closed', () => {
  const actor: any = { id: 'u2', name: 'B', email: 'b@x.test', workspaceId: 'w1', permissions: ['APPROVE_DOCUMENTS'] }
  const request = {
    id: 'r1', workspace_id: 'w1', workflow_id: 'wf1', document_type: 'sow', document_id: 'd1', project_id: null,
    requested_by: 'u1', status: 'pending', current_step: 2, total_steps: 2, context: {},
    allow_self_approval: false, require_distinct_approvers: true,
  }
  const step = { id: 's2', step_order: 2, approver_role_id: null, approver_user_id: 'u2', status: 'pending' }

  it('a failed "did this person already approve an earlier step" read refuses instead of waving them through', async () => {
    const svc: any = fake({ approval_requests: ok(request), approval_steps: [ok([step]), boom] })
    const r = await recordApprovalDecision(svc, { requestId: 'r1', actor, decision: 'approved' })
    expect(r).toMatchObject({ ok: false, status: 500 })
  })
  it('a failed role lookup for a role-assigned step is a retryable 500, not "you are not an approver"', async () => {
    const roleStep = { ...step, approver_user_id: null, approver_role_id: 'role1' }
    const svc: any = fake({ approval_requests: ok(request), approval_steps: ok([roleStep]), workspace_members: boom })
    const r = await recordApprovalDecision(svc, { requestId: 'r1', actor, decision: 'approved' })
    expect(r).toMatchObject({ ok: false, status: 500 })
  })
})

describe('reassignApprovalStep distinct-approver pre-flight fails closed', () => {
  const request = {
    id: 'r1', workspace_id: 'w1', project_id: null, document_type: 'sow', document_id: 'd1', status: 'pending',
    current_step: 1, total_steps: 2, requested_by: 'u1', context: {},
    allow_self_approval: false, require_distinct_approvers: true, sending_started_at: null,
  }
  const step = { id: 's1', step_order: 1, status: 'pending', approver_user_id: 'u2', approver_role_id: null }
  const candidate = { user_id: 'u3', role_id: null, effective_permissions: { APPROVE_DOCUMENTS: true }, users: { id: 'u3', name: 'C', email: 'c@x.test' } }
  const params: any = { requestId: 'r1', workspaceId: 'w1', actor: { id: 'u9', name: 'Admin', email: 'ad@x.test' }, target: { userId: 'u3' } }

  it('refuses (500) when the earlier-approvals read fails, instead of reassigning with an empty quota set', async () => {
    const svc: any = fake({ approval_requests: ok(request), approval_steps: [ok(step), boom], workspace_members: ok([candidate]) })
    expect(await reassignApprovalStep(svc, params)).toMatchObject({ ok: false, status: 500 })
  })
  it('refuses (500) when the remaining-steps read fails, instead of running the strand check on zero steps', async () => {
    const svc: any = fake({ approval_requests: ok(request), approval_steps: [ok(step), ok([]), boom], workspace_members: ok([candidate]) })
    expect(await reassignApprovalStep(svc, params)).toMatchObject({ ok: false, status: 500 })
  })
  it('a failed approver-candidate read throws rather than reading as "nobody can decide this"', async () => {
    const svc: any = fake({ approval_requests: ok(request), approval_steps: ok(step), workspace_members: boom })
    await expect(reassignApprovalStep(svc, params)).rejects.toThrow(/approver candidates/)
  })
})
