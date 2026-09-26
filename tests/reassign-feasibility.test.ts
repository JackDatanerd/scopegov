// tests/reassign-feasibility.test.ts
//
// FIX (section-11 re-audit — flagship finding): reassignApprovalStep used to check
// only whether the proposed new assignee could decide the step being reassigned
// RIGHT NOW — never whether doing so would strand a LATER, not-yet-decided step
// under require_distinct_approvers (the same bipartite-matching feasibility check
// already run at request creation, via checkChainFeasibility, was never re-run
// here). This drives reassignApprovalStep end-to-end against an in-memory fake
// Supabase (no real DB — see tests/pg-replay for the migration-level RPC coverage)
// to prove the fix: a reassignment that would deadlock a later step is refused,
// with nothing written, and one that doesn't is still allowed through.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ insertNotificationRows: async () => true }))
vi.mock('@/lib/utils/permissions-query', () => ({
  filterToProjectAccess: async (_s: any, _p: any, recipients: any[]) => recipients,
  filterByNotificationPreference: async (_s: any, _w: any, _e: any, recipients: any[]) => recipients,
  getMembersWithRole: async () => [],
}))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: async () => ({ ok: true }),
  sendApprovalDecisionEmail: async () => ({ ok: true }),
}))

import { reassignApprovalStep } from '@/lib/approvals/engine'

const member = (id: string, name: string) =>
  ({ id: `wm-${id}`, workspace_id: 'w1', user_id: id, status: 'active', role_id: null,
     effective_permissions: { APPROVE_DOCUMENTS: true }, users: { id, name, email: `${id}@test.dev` } })

function seed(over: { steps?: any[] } = {}) {
  return createFakeSupabase({
    approval_requests: [{
      id: 'req1', workspace_id: 'w1', project_id: null, document_type: 'sow', document_id: 'doc1',
      requested_by: 'requester1', status: 'pending', current_step: 1, total_steps: 2,
      context: { title: 'Test SOW' }, allow_self_approval: false, require_distinct_approvers: true,
      sending_started_at: null,
    }],
    approval_steps: over.steps || [
      { id: 's1', request_id: 'req1', step_order: 1, approver_role_id: null, approver_user_id: 'alice', status: 'pending' },
      { id: 's2', request_id: 'req1', step_order: 2, approver_role_id: null, approver_user_id: 'bob', status: 'pending' },
    ],
    workspace_members: [member('alice', 'Alice'), member('bob', 'Bob'), member('carol', 'Carol')],
    users: [{ id: 'requester1', name: 'Requester', email: 'requester1@test.dev' }],
  })
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('reassignApprovalStep — distinct-approver feasibility for later steps', () => {
  it('refuses to reassign step 1 to the person exclusively assigned to step 2 (would deadlock it)', async () => {
    const { client, tables } = seed()
    const result = await reassignApprovalStep(client, {
      requestId: 'req1', workspaceId: 'w1',
      actor: { id: 'admin1', name: 'Admin', email: 'admin1@test.dev' },
      target: { userId: 'bob' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toMatch(/strand a later step/i)
    }
    // Nothing was written — step 1 is still assigned to alice.
    expect(tables.approval_steps.find((s: any) => s.id === 's1').approver_user_id).toBe('alice')
  })

  it('still allows reassigning step 1 to a third person who does not collide with step 2', async () => {
    const { client, tables } = seed()
    const result = await reassignApprovalStep(client, {
      requestId: 'req1', workspaceId: 'w1',
      actor: { id: 'admin1', name: 'Admin', email: 'admin1@test.dev' },
      target: { userId: 'carol' },
    })
    expect(result.ok).toBe(true)
    expect(tables.approval_steps.find((s: any) => s.id === 's1').approver_user_id).toBe('carol')
  })

  it('does not run the later-step check (and does not block) when require_distinct_approvers is off', async () => {
    const { client, tables } = createFakeSupabase({
      approval_requests: [{
        id: 'req1', workspace_id: 'w1', project_id: null, document_type: 'sow', document_id: 'doc1',
        requested_by: 'requester1', status: 'pending', current_step: 1, total_steps: 2,
        context: { title: 'Test SOW' }, allow_self_approval: false, require_distinct_approvers: false,
        sending_started_at: null,
      }],
      approval_steps: [
        { id: 's1', request_id: 'req1', step_order: 1, approver_role_id: null, approver_user_id: 'alice', status: 'pending' },
        { id: 's2', request_id: 'req1', step_order: 2, approver_role_id: null, approver_user_id: 'bob', status: 'pending' },
      ],
      workspace_members: [member('alice', 'Alice'), member('bob', 'Bob')],
      users: [{ id: 'requester1', name: 'Requester', email: 'requester1@test.dev' }],
    })
    const result = await reassignApprovalStep(client, {
      requestId: 'req1', workspaceId: 'w1',
      actor: { id: 'admin1', name: 'Admin', email: 'admin1@test.dev' },
      target: { userId: 'bob' },
    })
    expect(result.ok).toBe(true)
    expect(tables.approval_steps.find((s: any) => s.id === 's1').approver_user_id).toBe('bob')
  })

  it('a person who already approved step 1 is excluded from step 2\'s later-step check too', async () => {
    // current_step is now 2; alice already approved step 1. Reassigning step 2 to alice must be
    // refused by the ordinary candidate check (she already used her one-step quota) — this just
    // confirms the new later-step feasibility pass doesn't accidentally let her back in either.
    const { client } = createFakeSupabase({
      approval_requests: [{
        id: 'req1', workspace_id: 'w1', project_id: null, document_type: 'sow', document_id: 'doc1',
        requested_by: 'requester1', status: 'pending', current_step: 2, total_steps: 2,
        context: { title: 'Test SOW' }, allow_self_approval: false, require_distinct_approvers: true,
        sending_started_at: null,
      }],
      approval_steps: [
        { id: 's1', request_id: 'req1', step_order: 1, approver_role_id: null, approver_user_id: 'alice', status: 'approved', decided_by: 'alice' },
        { id: 's2', request_id: 'req1', step_order: 2, approver_role_id: null, approver_user_id: 'bob', status: 'pending' },
      ],
      workspace_members: [member('alice', 'Alice'), member('bob', 'Bob')],
      users: [{ id: 'requester1', name: 'Requester', email: 'requester1@test.dev' }],
    })
    const result = await reassignApprovalStep(client, {
      requestId: 'req1', workspaceId: 'w1',
      actor: { id: 'admin1', name: 'Admin', email: 'admin1@test.dev' },
      target: { userId: 'alice' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400) // the ordinary "already used their quota" candidate check
  })
})
