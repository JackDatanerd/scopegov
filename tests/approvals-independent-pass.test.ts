// tests/approvals-independent-pass.test.ts
//
// Section-11 independent pass (B1–B5):
//   B3 — cancelApprovalRequest's write must be guarded against a send claim that landed after its read
//   B4 — the no-reachable-approver cron alert is scoped to the request's project like its siblings
//   B1/B2 — ApprovalsClient tab defaults and out-of-order load protection
//   B5 — project tabs only offer retry/cancel to the requester or an admin

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))

import { cancelApprovalRequest, SEND_CLAIM_WINDOW_MS } from '@/lib/approvals/engine'

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

/** A chainable, awaitable PostgREST-ish stub. `onOr` records every .or() argument with the verb that preceded it. */
function fakeService(opts: { lookup: any[]; updateResult: any }) {
  const ors: Array<{ verb: string; arg: string }> = []
  function builder(verb: string, resolveWith: () => any): any {
    const b: any = new Proxy(function () {}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve(resolveWith()).then(res, rej)
        if (prop === 'or') return (arg: string) => { ors.push({ verb, arg }); return b }
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(resolveWith())
        return () => b
      },
    })
    return b
  }
  const service: any = {
    from: () => ({
      select: () => builder('select', () => ({ data: opts.lookup, error: null })),
      update: () => builder('update', () => ({ data: opts.updateResult, error: null })),
      insert: () => builder('insert', () => ({ data: null, error: null })),
    }),
  }
  return { service, ors }
}

const baseParams = {
  documentType: 'sow' as const, documentId: 'd1', workspaceId: 'w1',
  actorId: 'u1', actorEmail: 'a@b.c', actorName: 'A',
}

describe('B3 — cancel cannot overwrite a request whose final-approval send has started', () => {
  it('the cancel write carries a send-claim guard (null or stale claim only), for both states it can cancel', async () => {
    const { service, ors } = fakeService({
      lookup: [{ id: 'r1', project_id: 'p1', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }],
      updateResult: null, // the guarded write matched nothing → cancel must bail out quietly
    })
    await cancelApprovalRequest(service, baseParams)
    const writeOr = ors.find(o => o.verb === 'update')
    expect(writeOr).toBeTruthy()
    const groups = writeOr!.arg.split(/,(?=and\()/)
    expect(groups).toHaveLength(4)
    // every alternative constrains sending_started_at; none is a bare status match
    for (const g of groups) expect(g).toMatch(/sending_started_at\.(is\.null|lt\.)/)
    expect(groups.filter(g => g.includes('status.eq.pending'))).toHaveLength(2)
    expect(groups.filter(g => g.includes('status.eq.approved') && g.includes('send_failed_at.not.is.null'))).toHaveLength(2)
  })

  it('the stale cut-off in the guard is the same window the pre-read uses', async () => {
    const { service, ors } = fakeService({
      lookup: [{ id: 'r1', project_id: 'p1', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }],
      updateResult: null,
    })
    const before = Date.now()
    await cancelApprovalRequest(service, baseParams)
    const ts = /sending_started_at\.lt\.([0-9T:.\-]+Z)/.exec(ors.find(o => o.verb === 'update')!.arg)![1]
    const cutoff = Date.parse(ts)
    expect(cutoff).toBeLessThanOrEqual(before - SEND_CLAIM_WINDOW_MS + 1000)
    expect(cutoff).toBeGreaterThan(before - SEND_CLAIM_WINDOW_MS - 5000)
  })

  it('a live claim at read time still short-circuits before any write', async () => {
    const { service, ors } = fakeService({
      lookup: [{ id: 'r1', project_id: 'p1', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: new Date().toISOString() }],
      updateResult: { id: 'r1' },
    })
    await cancelApprovalRequest(service, baseParams)
    expect(ors.some(o => o.verb === 'update')).toBe(false)
  })
})

describe('B4 — stall cron scopes the no-reachable-approver alert to the project', () => {
  it('every notifyMembersWithPermission call in the cron passes projectId', () => {
    const src = read('app/api/cron/approval-stall/route.ts')
    const calls = src.split('notifyMembersWithPermission(service, {').slice(1)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) expect(c).toContain("entityType: 'approval_request', entityId: r.id, projectId: r.project_id")
  })
})

describe('B1/B2 — ApprovalsClient', () => {
  const src = read('components/approvals/ApprovalsClient.tsx')
  it('"My queue" is offered (and is the landing tab) only to members who can approve', () => {
    expect(src).toContain("if (canApprove) tabs.push({ id: 'mine'")
    expect(src).toContain("canApprove ? 'mine' : canViewAll ? 'all' : 'submitted'")
    expect(src).not.toContain("if (canApprove || canViewAll) tabs.push")
  })
  it('oversight-only members start on pending so the page matches the sidebar badge', () => {
    expect(src).toContain("useState(!canApprove && canViewAll ? 'pending' : '')")
  })
  it('load() ignores responses that are no longer the latest request', () => {
    expect(src).toContain('const seq = ++loadSeq.current')
    expect((src.match(/seq !== loadSeq\.current/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(src).toContain('if (seq === loadSeq.current) setLoading(false)')
  })
})

describe('B5 — retry/cancel buttons on the project tabs follow the server rule', () => {
  it('the map carries canManage = requester or MANAGE_WORKSPACE_SETTINGS', () => {
    const src = read('app/(app)/projects/[id]/page.tsx')
    expect(src).toContain("canManage: r.requested_by === session.id || hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')")
    expect(src).toContain('send_failed_reason, requested_by')
  })
  it('SOW, CO and invoice retry/cancel buttons are gated on it', () => {
    const detail = read('components/projects/ProjectDetail.tsx')
    const billing = read('components/invoices/BillingTab.tsx')
    expect(detail).toContain("pendingApproval.sendFailed && pendingApproval.canManage && permissions.sendSow")
    expect(detail).toContain("pendingApproval.sendFailed && pendingApproval.canManage && permissions.sendCo")
    expect(billing).toContain("pendingApproval.sendFailed && pendingApproval.canManage && permissions.sendInvoices")
  })
})
