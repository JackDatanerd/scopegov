// tests/approvals-notify-distinct.test.ts
//
// Section-11 audit fixes (B2 + B3), driven end-to-end against the in-memory fake Supabase:
//   B3 — with require_distinct_approvers, someone who already approved an earlier step must not be told a
//        later step is "awaiting your approval" (they can never decide it) and must not count as reached.
//   B2 — a recipient-lookup failure AFTER a change has committed must not turn a successful reassignment into
//        an error; the stall-cron reminder path must still surface it (not misreport 'no_recipients').

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  inserted: [] as any[],
  roleLimits: [] as number[],
  roleMembers: [] as Array<{ id: string; name: string; email: string }>,
  failLookups: false,
}))

vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({
  insertNotificationRows: async (_s: any, rows: any[]) => { h.inserted.push(...rows); return true },
}))
vi.mock('@/lib/utils/permissions-query', () => ({
  filterToProjectAccess: async (_s: any, _p: any, recipients: any[]) => {
    if (h.failLookups) throw new Error('boom: project access lookup')
    return recipients
  },
  filterByNotificationPreference: async (_s: any, _w: any, _e: any, recipients: any[]) => {
    if (h.failLookups) throw new Error('boom: preference lookup')
    return recipients
  },
  getMembersWithRole: async (_s: any, _w: any, _r: any, limit: number) => {
    if (h.failLookups) throw new Error('boom: members lookup')
    h.roleLimits.push(limit)
    return h.roleMembers.slice(0, limit)
  },
}))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: async () => ({ ok: true }),
  sendApprovalDecisionEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/documents/send-sow', () => ({ sendSowDocument: async () => ({ ok: true }) }))
vi.mock('@/lib/documents/send-co', () => ({ sendCoDocument: async () => ({ ok: true }) }))
vi.mock('@/lib/documents/send-invoice', () => ({ sendInvoiceDocument: async () => ({ ok: true }) }))
vi.mock('@/lib/documents/accept-co-counter', () => ({ acceptCoCounter: async () => ({ ok: true }) }))

import { sendApprovalReminder, reassignApprovalStep } from '@/lib/approvals/engine'

const person = (id: string) => ({ id, name: id[0].toUpperCase() + id.slice(1), email: `${id}@test.dev` })

function seedRoleChain(distinct: boolean) {
  return createFakeSupabase({
    approval_requests: [{
      id: 'req1', workspace_id: 'w1', project_id: 'p1', document_type: 'sow', document_id: 'doc1',
      requested_by: 'requester1', status: 'pending', current_step: 2, total_steps: 2,
      context: { title: 'Test SOW', project_name: 'Proj' }, allow_self_approval: false,
      require_distinct_approvers: distinct, sending_started_at: null,
    }],
    approval_steps: [
      { id: 's1', request_id: 'req1', step_order: 1, approver_role_id: 'role1', approver_user_id: null, status: 'approved', decided_by: 'alice' },
      { id: 's2', request_id: 'req1', step_order: 2, approver_role_id: 'role1', approver_user_id: null, status: 'pending', decided_by: null },
    ],
    users: [{ id: 'requester1', name: 'Requester', email: 'requester1@test.dev' }],
    workspace_members: [],
  })
}

beforeEach(() => { h.inserted = []; h.roleLimits = []; h.roleMembers = []; h.failLookups = false })

describe('B3 — earlier approvers are not asked to decide a later step', () => {
  it('reminder skips someone who already approved step 1 when approvers must be distinct', async () => {
    h.roleMembers = [person('alice'), person('bob')]
    const { client } = seedRoleChain(true)
    const res = await sendApprovalReminder(client, 'req1')
    expect(res).toBe('sent')
    expect(h.inserted.map(r => r.recipient_id)).toEqual(['bob'])
    // over-fetched by the number of excluded approvers so the cap can't squeeze a real approver out
    expect(h.roleLimits.every(l => l === 26)).toBe(true)
  })

  it('reports no_recipients when the only remaining role holder is the disqualified earlier approver', async () => {
    h.roleMembers = [person('alice')]
    const { client } = seedRoleChain(true)
    expect(await sendApprovalReminder(client, 'req1')).toBe('no_recipients')
    expect(h.inserted).toEqual([])
  })

  it('still notifies the earlier approver when distinct approvers are NOT required', async () => {
    h.roleMembers = [person('alice'), person('bob')]
    const { client } = seedRoleChain(false)
    expect(await sendApprovalReminder(client, 'req1')).toBe('sent')
    expect(h.inserted.map(r => r.recipient_id).sort()).toEqual(['alice', 'bob'])
  })
})

describe('B2 — lookup failures after a committed change', () => {
  it('a failed recipient lookup does not fail a reassignment that already committed', async () => {
    const { client, tables } = createFakeSupabase({
      approval_requests: [{
        id: 'req1', workspace_id: 'w1', project_id: null, document_type: 'sow', document_id: 'doc1',
        requested_by: 'requester1', status: 'pending', current_step: 1, total_steps: 1,
        context: { title: 'Test SOW' }, allow_self_approval: false, require_distinct_approvers: false,
        sending_started_at: null,
      }],
      approval_steps: [
        { id: 's1', request_id: 'req1', step_order: 1, approver_role_id: null, approver_user_id: 'alice', status: 'pending' },
      ],
      workspace_members: [
        { id: 'wm-alice', workspace_id: 'w1', user_id: 'alice', status: 'active', role_id: null, effective_permissions: { APPROVE_DOCUMENTS: true }, users: person('alice') },
        { id: 'wm-carol', workspace_id: 'w1', user_id: 'carol', status: 'active', role_id: null, effective_permissions: { APPROVE_DOCUMENTS: true }, users: person('carol') },
      ],
      users: [{ id: 'requester1', name: 'Requester', email: 'requester1@test.dev' }],
    })
    h.failLookups = true
    const result = await reassignApprovalStep(client, {
      requestId: 'req1', workspaceId: 'w1',
      actor: { id: 'admin1', name: 'Admin', email: 'admin1@test.dev' },
      target: { userId: 'carol' },
    })
    expect(result.ok).toBe(true)
    expect(tables.approval_steps!.find((s: any) => s.id === 's1')!.approver_user_id).toBe('carol')
  })

  it('the stall-cron reminder surfaces a lookup failure instead of reporting no_recipients', async () => {
    const { client } = seedRoleChain(false)
    h.failLookups = true
    await expect(sendApprovalReminder(client, 'req1')).rejects.toThrow(/boom/)
  })
})
