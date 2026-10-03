// tests/approvals-pass-3-fixes.test.ts
//
// Approvals audit (section 11), third round:
//   B1 canReadProject read a failed lookup as "no access" (a false 403/404 on a transient outage) — now thrown;
//   B2 reassign's requester lookup was unchecked — the new approver silently went un-notified;
//   B3 a new workflow was created ACTIVE before its steps existed — now created inactive, activated last;
//   B4 every workflow PATCH replaced the steps and logged `steps` as changed, even when they were identical.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const state = { auditRows: [] as any[], notified: [] as any[] }

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))
vi.mock('@/lib/email/templates', () => ({
  sendApprovalRequestedEmail: vi.fn(async () => ({ ok: true })),
  sendApprovalDecisionEmail: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/utils/audit', () => ({
  logAudit: vi.fn(async (_s: any, p: any) => { state.auditRows.push(p); return true }),
  insertAuditRow: vi.fn(async (_s: any, r: any) => { state.auditRows.push(r); return true }),
}))
vi.mock('@/lib/utils/notify', () => ({
  insertNotificationRows: vi.fn(async (_s: any, rows: any[]) => { state.notified.push(...rows); return true }),
}))
vi.mock('@/lib/utils/permissions-query', () => ({
  getMembersWithRole: vi.fn(async () => []),
  filterByNotificationPreference: vi.fn(async (_s: any, _w: string, _e: string, r: any[]) => r),
  filterToProjectAccess: vi.fn(async (_s: any, _p: any, r: any[]) => r),
}))

import { reassignApprovalStep } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'

type Res = { data: any; error: any }
const ok = (data: any): Res => ({ data, error: null })
const boom: Res = { data: null, error: { message: 'connection reset' } }

function fake(tables: Record<string, Res | Res[]>) {
  const counters: Record<string, number> = {}
  return {
    rpc: vi.fn(() => Promise.resolve(ok(true))),
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

beforeEach(() => { state.auditRows = []; state.notified = [] })

describe('B1 — canReadProject: a failed read is an error, not "no access"', () => {
  const admin: any = { id: 'u1', workspaceId: 'w1', permissions: ['VIEW_ALL_PROJECTS'] }
  const member: any = { id: 'u2', workspaceId: 'w1', permissions: [] }

  it('throws when the VIEW_ALL_PROJECTS project lookup fails', async () => {
    await expect(canReadProject(fake({ projects: boom }), admin, 'p1')).rejects.toThrow(/project lookup failed/)
  })
  it('throws when the membership lookup fails', async () => {
    await expect(canReadProject(fake({ project_members_active: boom }), member, 'p1')).rejects.toThrow(/membership lookup failed/)
  })
  it('still answers false when the project genuinely is not visible, true when it is', async () => {
    expect(await canReadProject(fake({ projects: ok([]) }), admin, 'p1')).toBe(false)
    expect(await canReadProject(fake({ projects: ok([{ id: 'p1' }]) }), admin, 'p1')).toBe(true)
    expect(await canReadProject(fake({ project_members_active: ok([]) }), member, 'p1')).toBe(false)
    expect(await canReadProject(fake({ project_members_active: ok([{ project_id: 'p1' }]) }), member, 'p1')).toBe(true)
  })
  it('the project page tab title falls back instead of crashing on that throw', () => {
    const src = readFileSync('app/(app)/projects/[id]/page.tsx', 'utf8')
    expect(src).toMatch(/try \{\s*\n\s*if \(!\(await canReadProject\(service, session, id\)\)\) return \{ title: 'Project' \}\s*\n\s*\} catch \{ return \{ title: 'Project' \} \}/)
  })
})

describe('B2 — reassign: the requester lookup is read, retried, and leaves a trail', () => {
  const request = { id: 'r1', project_id: 'p1', document_type: 'sow', document_id: 'd1', requested_by: 'req', status: 'pending',
    current_step: 1, total_steps: 1, context: { title: 'T' }, allow_self_approval: false, require_distinct_approvers: false, sending_started_at: null }
  const step = { id: 's1', step_order: 1, approver_role_id: 'roleOld', approver_user_id: null, status: 'pending' }
  const actor = { id: 'admin', name: 'Admin', email: 'a@x.test' }
  const member = (id: string) => ({ user_id: id, role_id: 'x', effective_permissions: { APPROVE_DOCUMENTS: true }, users: { id, name: id, email: `${id}@x.test` } })
  const base = () => ({
    approval_requests: ok(request), approval_steps: [ok(step), ok({ id: 's1' })], workspace_members: ok([member('newUser')]),
  })

  it('records approval.reassign_notify_skipped when the requester lookup keeps failing, and still succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = fake({ ...base(), users: boom })
    const r = await reassignApprovalStep(svc, { requestId: 'r1', workspaceId: 'w1', actor, target: { userId: 'newUser' } })
    expect(r.ok).toBe(true)
    expect(err.mock.calls.filter(c => String(c[0]).includes('requester lookup failed')).length).toBe(2)
    expect(state.auditRows.some(a => a.eventType === 'approval.reassign_notify_skipped')).toBe(true)
    err.mockRestore()
  })
  it('a transient failure followed by a good read leaves no skip trail', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = fake({ ...base(), users: [boom, ok({ id: 'req', name: 'R', email: 'r@x.test' })] })
    const r = await reassignApprovalStep(svc, { requestId: 'r1', workspaceId: 'w1', actor, target: { userId: 'newUser' } })
    expect(r.ok).toBe(true)
    expect(state.auditRows.some(a => a.eventType === 'approval.reassign_notify_skipped')).toBe(false)
    err.mockRestore()
  })
  it('a requester who genuinely no longer exists is not a failure', async () => {
    const svc = fake({ ...base(), users: ok(null) })
    const r = await reassignApprovalStep(svc, { requestId: 'r1', workspaceId: 'w1', actor, target: { userId: 'newUser' } })
    expect(r.ok).toBe(true)
    expect(state.auditRows.some(a => a.eventType === 'approval.reassign_notify_skipped')).toBe(false)
  })
})

describe('B3 — workflow POST: created inactive, activated only once its steps exist', () => {
  const src = readFileSync('app/api/approval-workflows/route.ts', 'utf8')
  it('inserts the workflow with is_active: false', () => {
    const insertAt = src.indexOf(".from('approval_workflows')\n      .insert({")
    expect(insertAt).toBeGreaterThan(-1)
    const block = src.slice(insertAt, src.indexOf('.single()', insertAt))
    expect(block).toMatch(/is_active: false/)
    expect(block).not.toMatch(/is_active: true/)
  })
  it('activates after the steps insert and before the audit row', () => {
    const stepsAt = src.indexOf(".from('approval_workflow_steps').insert(")
    const activateAt = src.indexOf('is_active: true, updated_at')
    const auditAt = src.indexOf("eventType: 'approval_workflow.created'")
    expect(stepsAt).toBeGreaterThan(-1)
    expect(activateAt).toBeGreaterThan(stepsAt)
    expect(auditAt).toBeGreaterThan(activateAt)
  })
  it('maps a duplicate caught at activation to the same 409 and removes the half-made rule', () => {
    const tail = src.slice(src.indexOf('is_active: true, updated_at'))
    expect(tail).toMatch(/activateErr\?\.code === '23505'/)
    expect(tail).toMatch(/\.from\('approval_workflows'\)\.delete\(\)\.eq\('id', workflow\.id\)/)
    expect(tail).toMatch(/status: 409/)
  })
})

describe('B4 — workflow PATCH: identical steps are dropped, not rewritten and logged', () => {
  const src = readFileSync('app/api/approval-workflows/[id]/route.ts', 'utf8')
  it('reads the stored step rows (not just a count) and compares them in order', () => {
    expect(src).toMatch(/select\('step_order, approver_role_id, approver_user_id'\)/)
    expect(src).toMatch(/steps = undefined/)
    expect(src).toMatch(/steps\.length === existingStepCount/)
  })
  it('the drop happens before the unchanged shortcut and the audit row', () => {
    const dropAt = src.indexOf('steps = undefined')
    expect(dropAt).toBeGreaterThan(-1)
    expect(src.indexOf('unchanged: true')).toBeGreaterThan(dropAt)
    expect(src.indexOf("eventType: 'approval_workflow.updated'")).toBeGreaterThan(dropAt)
  })
})
