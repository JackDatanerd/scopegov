// tests/approvals-independent-pass-15.test.ts
//
// Approvals independent pass (B1–B4).
//   B1 — dashboard / projects list / project page read approval_requests without looking at `error`
//   B2 — pickWorkflow compared currencies case-sensitively (a lowercase legacy project currency was never gated)
//   B3 — an approved-but-not-sent invoice on a Complete/Archived project never reached "needs attention"
//   B4 — the stall cron re-alerted admins about an unsent approved request forever

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, notified: [] as any[], audits: [] as any[] }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.audits.push(row); return true },
}))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async (_s: any, p: any) => { h.notified.push(p); return true } }))
vi.mock('@/lib/approvals/engine', () => ({
  healStuckSends: async () => [],
  documentLabelFor: (t: string) => t,
  sendApprovalReminder: async () => 'sent',
}))

import { POST as approvalStall } from '@/app/api/cron/approval-stall/route'
import { pickWorkflow } from '@/lib/approvals/pick-workflow'
import { isAttentionWorthy, attentionReason } from '@/lib/utils/attention'

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()

describe('B1 — approval reads on the pages are error-checked', () => {
  for (const file of ['app/(app)/dashboard/page.tsx', 'app/(app)/projects/page.tsx']) {
    it(`${file} logs a failed pending-approvals read`, () => {
      const src = read(file)
      expect(src).toContain('pending approvals read failed')
      expect(src).not.toMatch(/\(await buildPendingApprovalsQuery\(\)\)\.data/)
      expect(src).not.toMatch(/buildPendingApprovalsQuery\(\)\.in\('project_id', chunk\)\)\)\.data/)
    })
  }
  it('the project page reads and logs the error', () => {
    const src = read('app/(app)/projects/[id]/page.tsx')
    expect(src).toMatch(/error: pendingApprovalErr/)
    expect(src).toContain('pendingApprovalErr.message')
  })
})

describe('B2 — pickWorkflow compares currencies case-insensitively', () => {
  const w = (id: string, threshold: number | null, currency: string | null, other = false) =>
    ({ id, threshold_amount: threshold, threshold_currency: currency, apply_to_other_currencies: other })

  it('a lowercase document currency still meets an upper-case threshold', () => {
    expect(pickWorkflow([w('a', 5000, 'USD')], 9000, 'usd')?.id).toBe('a')
    expect(pickWorkflow([w('a', 5000, 'USD')], 9000, ' Usd ')?.id).toBe('a')
  })
  it('a lowercase stored threshold currency matches too', () => {
    expect(pickWorkflow([w('a', 5000, 'usd')], 9000, 'USD')?.id).toBe('a')
  })
  it('below the threshold is still ungated, and different currencies still differ', () => {
    expect(pickWorkflow([w('a', 5000, 'USD')], 100, 'usd')).toBeNull()
    expect(pickWorkflow([w('a', 5000, 'USD')], 9000, 'eur')).toBeNull()
  })
  it('the other-currency opt-in does not capture the same currency written in another case', () => {
    const usdOptIn = w('a', 10000, 'USD', true)
    expect(pickWorkflow([usdOptIn], 1, 'usd')).toBeNull()
    expect(pickWorkflow([usdOptIn], 1, 'eur')?.id).toBe('a')
  })
  it('migration 146 upper-cases the stored codes', () => {
    const sql = read('supabase/migrations/146_currency_codes_uppercase.sql')
    expect(sql).toMatch(/UPDATE public\.projects[\s\S]*upper\(btrim\(currency\)\)/)
    expect(sql).toMatch(/UPDATE public\.invoices[\s\S]*upper\(btrim\(currency\)\)/)
  })
})

describe('B3 — send-failed approvals surface on finished projects', () => {
  const base: any = { id: 'p1', name: 'P', status: 'Complete', stallReason: null, contractValue: 1000, currency: 'USD', guardianFlags: [], changeOrders: [], sowDocuments: [] }
  const ctx = (over: any) => ({ project: { ...base, ...over }, workspace: { proactiveRiskAlertsEnabled: false, currency: 'USD' } })

  it('a Complete/Archived project with an approved-not-sent request needs attention, with the retry reason', () => {
    for (const status of ['Complete', 'Archived']) {
      const c = ctx({ status, pendingApprovals: [{ createdAt: ago(1), sendFailed: true }] })
      expect(isAttentionWorthy(c)).toBe(true)
      expect(attentionReason(c)).toBe('Approved but not sent — needs a retry')
    }
  })
  it('a merely pending request on a finished project, or nothing at all, still does not', () => {
    const c = ctx({ pendingApprovals: [{ createdAt: ago(30), sendFailed: false }] })
    expect(isAttentionWorthy(c)).toBe(false)
    expect(attentionReason(c)).toBeNull()
    expect(isAttentionWorthy(ctx({}))).toBe(false)
  })
})

describe('B4 — the send-failure escalation is capped', () => {
  beforeEach(() => {
    h.notified.length = 0; h.audits.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  const failed = (over: Row = {}) => ({
    id: 'r1', workspace_id: 'w1', project_id: 'p1', document_type: 'invoice', status: 'approved',
    send_failed_at: ago(9), send_failed_reason: 'x', sending_started_at: null, updated_at: ago(9), send_failure_alerts: 0, ...over,
  })
  const run = async () => { const res = await approvalStall({} as any); return res.json() }

  it('alerts the admins three times, one per window, then stops', async () => {
    h.db = createFakeSupabase({ approval_requests: [failed()] })
    for (let i = 1; i <= 3; i++) {
      const body = await run()
      expect(body.sendFailureEscalated).toBe(1)
      expect(h.db.tables.approval_requests[0].send_failure_alerts).toBe(i)
      h.db.tables.approval_requests[0].updated_at = ago(9)   // next window
    }
    const body = await run()
    expect(body.sendFailureEscalated).toBe(0)
    expect(h.notified.filter(n => n.type === 'approval_send_failed_stale')).toHaveLength(3)
  })
})
