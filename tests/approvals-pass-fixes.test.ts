// tests/approvals-pass-fixes.test.ts
//
// Section-11 pass-1 fixes that are pure logic:
//   B5 — workflow step / threshold parsing shared by POST and PATCH /api/approval-workflows
//   B4 — the "a send is running right now" clock used to refuse changing a document under a live auto-send
//   B2/G1 — canDecideRequest / decorate now live in lib/approvals/list.ts (shared by the list and the
//           single-request route); behaviour must be exactly what the list route always had.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))

import { parseWorkflowSteps, parseThresholdAmount, MAX_WORKFLOW_STEPS } from '@/lib/approvals/workflow-input'
import { isSendClaimLive, SEND_CLAIM_WINDOW_MS } from '@/lib/approvals/send-claim'
import { canDecideRequest, decorate } from '@/lib/approvals/list'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

describe('B5 — parseWorkflowSteps', () => {
  it('rejects a non-array, an empty array and too many steps', () => {
    expect(parseWorkflowSteps(undefined).ok).toBe(false)
    expect(parseWorkflowSteps([]).ok).toBe(false)
    expect(parseWorkflowSteps(Array(MAX_WORKFLOW_STEPS + 1).fill({ approverRoleId: U1 })).ok).toBe(false)
    expect(parseWorkflowSteps(Array(MAX_WORKFLOW_STEPS).fill({ approverRoleId: U1 })).ok).toBe(true)
  })

  it('a null / non-object entry is a clean validation error, not a TypeError (used to be a 500 on POST)', () => {
    for (const bad of [null, 5, 'x', [], undefined]) {
      const r = parseWorkflowSteps([bad])
      expect(r.ok).toBe(false)
    }
  })

  it('an empty-string approver id no longer slips through PATCH validation', () => {
    expect(parseWorkflowSteps([{ approverRoleId: '' }]).ok).toBe(false)
    expect(parseWorkflowSteps([{ approverUserId: '   ' }]).ok).toBe(false)
    expect(parseWorkflowSteps([{}]).ok).toBe(false)
  })

  it('requires exactly one approver per step, and a well-formed id', () => {
    expect(parseWorkflowSteps([{ approverRoleId: U1, approverUserId: U2 }]).ok).toBe(false)
    expect(parseWorkflowSteps([{ approverRoleId: 'not-a-uuid' }]).ok).toBe(false)
    expect(parseWorkflowSteps([{ approverRoleId: 5 }]).ok).toBe(false)
  })

  it('normalises a blank sibling field to null', () => {
    const r = parseWorkflowSteps([{ approverRoleId: '', approverUserId: U1 }, { approverRoleId: U2 }])
    expect(r).toEqual({
      ok: true,
      steps: [
        { approverRoleId: null, approverUserId: U1 },
        { approverRoleId: U2, approverUserId: null },
      ],
    })
  })
})

describe('B5 — parseThresholdAmount', () => {
  it('blank means "no threshold" (a catch-all)', () => {
    for (const v of [undefined, null, '']) expect(parseThresholdAmount(v)).toEqual({ ok: true, value: null })
  })
  it('zero and negatives are refused (0 behaved as a catch-all that skipped the duplicate guard)', () => {
    for (const v of [0, '0', -1, '-5']) expect(parseThresholdAmount(v).ok).toBe(false)
  })
  it('refuses non-numeric input and non-scalar types', () => {
    for (const v of ['abc', NaN, Infinity, {}, [], true]) expect(parseThresholdAmount(v).ok).toBe(false)
  })
  it('accepts a positive number or numeric string', () => {
    expect(parseThresholdAmount(25000)).toEqual({ ok: true, value: 25000 })
    expect(parseThresholdAmount('10000.5')).toEqual({ ok: true, value: 10000.5 })
  })
})

describe('B4 — isSendClaimLive', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  it('no claim is not live', () => {
    expect(isSendClaimLive(null, now)).toBe(false)
    expect(isSendClaimLive(undefined, now)).toBe(false)
    expect(isSendClaimLive('', now)).toBe(false)
  })
  it('a young claim is live, an old (presumed-dead) one is not', () => {
    expect(isSendClaimLive(new Date(now - 5_000).toISOString(), now)).toBe(true)
    expect(isSendClaimLive(new Date(now - SEND_CLAIM_WINDOW_MS + 1).toISOString(), now)).toBe(true)
    expect(isSendClaimLive(new Date(now - SEND_CLAIM_WINDOW_MS).toISOString(), now)).toBe(false)
    expect(isSendClaimLive(new Date(now - 60 * 60_000).toISOString(), now)).toBe(false)
  })
  it('an unparseable timestamp never reads as live forever', () => {
    expect(isSendClaimLive('garbage', now)).toBe(false)
  })
})

describe('list.ts — canDecideRequest / decorate (moved verbatim out of the list route)', () => {
  const session = (id: string, permissions: string[]) => ({ id, permissions, workspaceId: 'w1' })
  const request = (over: any = {}) => ({
    id: 'r1', status: 'pending', current_step: 1, requested_by: 'requester', sending_started_at: null,
    allow_self_approval: false, require_distinct_approvers: false,
    context: { title: 'T', amount: 5000, currency: 'USD' },
    approval_steps: [{ step_order: 1, status: 'pending', approver_user_id: 'alice', approver_role_id: null, decided_by: null }],
    ...over,
  })

  it('the assigned approver with the permission can decide', () => {
    expect(canDecideRequest(request(), session('alice', ['APPROVE_DOCUMENTS']), null)).toBe(true)
  })
  it('someone else, someone without the permission, and a sending request cannot', () => {
    expect(canDecideRequest(request(), session('bob', ['APPROVE_DOCUMENTS']), null)).toBe(false)
    expect(canDecideRequest(request(), session('alice', []), null)).toBe(false)
    expect(canDecideRequest(request({ sending_started_at: new Date().toISOString() }), session('alice', ['APPROVE_DOCUMENTS']), null)).toBe(false)
    expect(canDecideRequest(request({ status: 'approved' }), session('alice', ['APPROVE_DOCUMENTS']), null)).toBe(false)
  })
  it('a role step matches on the viewer\'s role, and the requester is excluded unless self-approval is allowed', () => {
    const roleReq = request({ approval_steps: [{ step_order: 1, status: 'pending', approver_user_id: null, approver_role_id: 'roleA', decided_by: null }] })
    expect(canDecideRequest(roleReq, session('carol', ['APPROVE_DOCUMENTS']), 'roleA')).toBe(true)
    expect(canDecideRequest(roleReq, session('carol', ['APPROVE_DOCUMENTS']), 'roleB')).toBe(false)
    expect(canDecideRequest(roleReq, session('requester', ['APPROVE_DOCUMENTS']), 'roleA')).toBe(false)
    expect(canDecideRequest({ ...roleReq, allow_self_approval: true }, session('requester', ['APPROVE_DOCUMENTS']), 'roleA')).toBe(true)
  })
  it('with distinct approvers, someone who already approved an earlier step cannot decide this one', () => {
    const chain = request({
      current_step: 2, require_distinct_approvers: true,
      approval_steps: [
        { step_order: 1, status: 'approved', approver_user_id: 'alice', approver_role_id: null, decided_by: 'alice' },
        { step_order: 2, status: 'pending', approver_user_id: null, approver_role_id: 'roleA', decided_by: null },
      ],
    })
    expect(canDecideRequest(chain, session('alice', ['APPROVE_DOCUMENTS']), 'roleA')).toBe(false)
    expect(canDecideRequest(chain, session('bob', ['APPROVE_DOCUMENTS']), 'roleA')).toBe(true)
  })

  it('decorate strips decided_by, adds canDecide, and hides the amount from a viewer with no money access', () => {
    const [seenByOutsider] = decorate([request()], session('dana', ['VIEW_ALL_PROJECTS']), null)
    expect(seenByOutsider.canDecide).toBe(false)
    expect(seenByOutsider.context.amount).toBeNull()
    expect(seenByOutsider.approval_steps[0]).not.toHaveProperty('decided_by')

    const [seenByApprover] = decorate([request()], session('alice', ['APPROVE_DOCUMENTS']), null)
    expect(seenByApprover.canDecide).toBe(true)
    expect(seenByApprover.context.amount).toBe(5000)

    const [seenByRequester] = decorate([request()], session('requester', []), null)
    expect(seenByRequester.context.amount).toBe(5000)

    const [seenByFinance] = decorate([request()], session('erin', ['VIEW_FINANCIALS']), null)
    expect(seenByFinance.context.amount).toBe(5000)
  })
})
