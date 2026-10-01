import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'

// Workspace lifecycle (fresh independent pass):
//  B1  restore re-enables a Paystack subscription ONLY when workspace/delete is what cancelled it
//  B2  delete reports whether the caller still has a live workspace (Settings no longer signs them out)
//  B3  Settings shows the Delete form only to someone who can actually delete

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

const resumePaystackSubscription = vi.fn()
const alertBillingOps = vi.fn(async () => {})
vi.mock('@/lib/integrations/paystack', () => ({ resumePaystackSubscription }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => true) }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceRestoredEmail: vi.fn(async () => {}) }))

let billingRow: any = null
const billingUpdates: any[] = []

function builder(table: string) {
  let isUpdate = false
  let payload: any = null
  const result = () => {
    if (table === 'billing' && isUpdate) { billingUpdates.push(payload); return { data: null, error: null } }
    if (table === 'billing') return { data: billingRow, error: null }
    if (table === 'users') return { data: { name: 'Owner', deleted_at: null }, error: null }
    if (table === 'workspaces') return { data: { agency_name: 'Acme', name: 'Acme' }, error: null }
    return { data: [], error: null }
  }
  const b: any = new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
      if (prop === 'maybeSingle') return async () => result()
      return (...a: any[]) => { if (prop === 'update') { isUpdate = true; payload = a[0] } return b }
    },
  })
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'o@x.co', user_metadata: {} } } }) },
  }),
  createServiceClient: () => ({ from: (t: string) => builder(t), rpc: async () => ({ error: null }) }),
}))

const WS = '11111111-2222-4333-8444-555555555555'
const post = () => new NextRequest('http://x/api/workspace/restore', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: WS }),
})

describe('B1 — restore only resumes a subscription that delete cancelled', () => {
  beforeEach(() => {
    resumePaystackSubscription.mockReset(); alertBillingOps.mockClear(); billingUpdates.length = 0
  })

  it('leaves an owner-requested cancellation alone (no marker → no resume, no flag change)', async () => {
    billingRow = { paystack_subscription_code: 'SUB_1', paystack_email_token: 't', cancels_at_period_end: true, cancelled_by_workspace_delete_at: null }
    const { POST } = await import('@/app/api/workspace/restore/route')
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(resumePaystackSubscription).not.toHaveBeenCalled()
    expect(billingUpdates).toHaveLength(0)
  })

  it('resumes and clears both flags when delete was the canceller', async () => {
    billingRow = { paystack_subscription_code: 'SUB_1', paystack_email_token: 't', cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-09-01T00:00:00Z' }
    resumePaystackSubscription.mockResolvedValue({ ok: true })
    const { POST } = await import('@/app/api/workspace/restore/route')
    await POST(post())
    expect(resumePaystackSubscription).toHaveBeenCalledTimes(1)
    expect(billingUpdates).toHaveLength(1)
    expect(billingUpdates[0]).toMatchObject({ cancels_at_period_end: false, cancelled_by_workspace_delete_at: null })
  })

  it('clears the marker even when the cancel webhook never set cancels_at_period_end', async () => {
    billingRow = { paystack_subscription_code: 'SUB_1', paystack_email_token: 't', cancels_at_period_end: false, cancelled_by_workspace_delete_at: '2026-09-01T00:00:00Z' }
    resumePaystackSubscription.mockResolvedValue({ ok: true })
    const { POST } = await import('@/app/api/workspace/restore/route')
    await POST(post())
    expect(billingUpdates[0]).toMatchObject({ cancelled_by_workspace_delete_at: null })
  })

  it('keeps the marker and pages billing ops when the resume fails; the restore still succeeds', async () => {
    billingRow = { paystack_subscription_code: 'SUB_1', paystack_email_token: 't', cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-09-01T00:00:00Z' }
    resumePaystackSubscription.mockResolvedValue({ ok: false, error: 'declined' })
    const { POST } = await import('@/app/api/workspace/restore/route')
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(billingUpdates).toHaveLength(0)
    expect(alertBillingOps).toHaveBeenCalledTimes(1)
  })

  it('does nothing billing-related when there is no subscription', async () => {
    billingRow = null
    const { POST } = await import('@/app/api/workspace/restore/route')
    await POST(post())
    expect(resumePaystackSubscription).not.toHaveBeenCalled()
  })
})

describe('source contracts', () => {
  it('B1: delete marks the billing row only when it cancelled, and audits the truth', () => {
    const src = read('app/api/workspace/delete/route.ts')
    expect(src).toContain('!cancelResult.alreadyCancelled')
    expect(src).toContain('cancelled_by_workspace_delete_at: now')
    expect(src).toContain('metadata: { billing_cancelled: cancelledByDelete }')
    expect(src).not.toContain('billing_cancelled: !!billing?.paystack_subscription_code')
    expect(src).toContain("update({ cancelled_by_workspace_delete_at: null })")   // stale marker cleared when delete cancelled nothing
  })
  it('B1: migration 132 adds the column idempotently and backfills the open restore window', () => {
    const sql = read('supabase/migrations/132_billing_cancelled_by_workspace_delete.sql')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS cancelled_by_workspace_delete_at timestamptz')
    expect(sql).toContain("interval '30 days'")
    expect(sql).toContain("'cancellation_requested'")
  })
  it('B2: delete returns hasOtherWorkspace and Settings only signs out when there is none', () => {
    expect(read('app/api/workspace/delete/route.ts')).toContain('hasOtherWorkspace')
    const ui = read('components/settings/SettingsClient.tsx')
    expect(ui).toContain("if (json.hasOtherWorkspace) { window.location.href = '/dashboard'; return }")
  })
  it('B3: the Danger zone gates the delete form on canDeleteWorkspace, computed with the route\u2019s own rule', () => {
    const ui = read('components/settings/SettingsClient.tsx')
    expect(ui).toContain('!permissions.canDeleteWorkspace')
    const page = read('app/(app)/settings/page.tsx')
    expect(page).toContain('canDeleteWorkspace')
    expect(page).toContain("eq('user_id', ownerId).eq('status', 'active')")
  })
})
