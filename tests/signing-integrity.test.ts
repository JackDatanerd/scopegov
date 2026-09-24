import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, alerts: [] as any[], heartbeats: [] as any[] }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string, r: any) => { h.heartbeats.push({ name, r }) } }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push(row); return true },
  logAudit: async (_s: any, p: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ event_type: p.eventType, ...p }) },
}))

import { runSigningIntegrity } from '@/lib/documents/signing-integrity'
import { POST } from '@/app/api/cron/signing-integrity/route'

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
const project = (over: Row = {}) => ({ id: 'p1', name: 'Acme', status: 'Active', stall_reason: null, contract_value: 6000, currency: 'USD', guardian_email: 'proj-abc@guard.test', type: 'fixed', deleted_at: null, ...over })
const sow = (over: Row = {}) => ({
  id: 's1', version: 1, workspace_id: 'w1', project_id: 'p1', status: 'signed', signed_at: ago(3), document_number: 'SOW-1',
  sections: [{ id: 'deliverables', table: [{ deliverable: 'Homepage' }, { deliverable: 'Blog' }], content: '' }, { id: 'oos', content: '<ul><li>Logo design</li></ul>' }],
  metadata: { paymentStructure: '50_50' }, content_hash: 'h', pdf_path: 'w1/sow/s1.pdf', projects: project(), ...over,
})
const healthy = (): Record<string, Row[]> => ({
  sow_documents: [sow()], payment_milestones: [{ id: 'm1', sow_id: 's1' }], project_scope_snapshot: [{ id: 'snap', project_id: 'p1' }],
  projects: [project()], change_orders: [], amendments: [], audit_log: [],
})

beforeEach(() => { h.alerts.length = 0; h.heartbeats.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('signing-integrity sweep', () => {
  it('leaves a fully executed SOW alone and is silent', async () => {
    const db = createFakeSupabase(healthy()); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r).toMatchObject({ sowsChecked: 1, repairs: [], unrepairable: [], failures: [] })
  })

  it('repairs a signed SOW left with no activation, no milestones, no Guardian baseline and no Guardian address — using the live flow\'s own helpers', async () => {
    const db = createFakeSupabase({
      ...healthy(), payment_milestones: [], project_scope_snapshot: [],
      sow_documents: [sow({ projects: project({ status: 'Awaiting Signature', guardian_email: null }) })],
      projects: [project({ status: 'Awaiting Signature', guardian_email: null })],
    }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.repairs.map(x => x.repair).sort()).toEqual(['guardian_email_created', 'milestones_created', 'project_activated', 'scope_snapshot_written'])
    expect(r.failures).toEqual([])
    expect(db.tables.projects[0]).toMatchObject({ status: 'Active', stall_reason: null })
    expect(db.tables.projects[0].guardian_email).toMatch(/^proj-[0-9a-z]+@/)
    // 50/50 of 6000
    expect(db.tables.payment_milestones.map((m: Row) => m.amount)).toEqual([3000, 3000])
    expect(db.tables.project_scope_snapshot[0]).toMatchObject({ project_id: 'p1', last_updated_by: 'signing', deliverables: [{ title: 'Homepage' }, { title: 'Blog' }], out_of_scope: [{ title: 'Logo design' }] })
    expect(db.tables.audit_log.filter((a: Row) => a.event_type === 'sow.integrity_repaired')).toHaveLength(4)
  })

  it("is idempotent — a second run finds nothing left to repair", async () => {
    const db = createFakeSupabase({ ...healthy(), payment_milestones: [], project_scope_snapshot: [] }); h.db = db
    await runSigningIntegrity(db.client)
    const again = await runSigningIntegrity(db.client)
    expect(again.repairs).toEqual([])
    expect(db.tables.payment_milestones).toHaveLength(2)
  })

  it("stamps a monthly retainer's first milestone with the day the client SIGNED, not the day the repair ran", async () => {
    const db = createFakeSupabase({
      ...healthy(), payment_milestones: [],
      sow_documents: [sow({ signed_at: '2026-03-20T10:00:00.000Z', metadata: { paymentStructure: 'monthly' } })],
    }); h.db = db
    await runSigningIntegrity(db.client, { now: new Date('2026-03-21T10:00:00Z') })
    expect(db.tables.payment_milestones).toHaveLength(1)
    expect(db.tables.payment_milestones[0]).toMatchObject({ type: 'retainer_monthly', due_date: '2026-03-20', amount: 6000 })
  })

  it('only repairs a project that was really left behind — an Active project, or one stalled for another reason, is untouched', async () => {
    const db = createFakeSupabase({ ...healthy(), sow_documents: [sow({ projects: project({ status: 'Stalled', stall_reason: 'manual' }) })], projects: [project({ status: 'Stalled', stall_reason: 'manual' })] }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.repairs).toEqual([])
    expect(db.tables.projects[0].status).toBe('Stalled')
  })

  it('recovers a project the sow-stall cron had stalled before the sign flow lost its activation write', async () => {
    const db = createFakeSupabase({ ...healthy(), sow_documents: [sow({ projects: project({ status: 'Stalled', stall_reason: 'sow_unsigned' }) })], projects: [project({ status: 'Stalled', stall_reason: 'sow_unsigned' })] }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.repairs.map(x => x.repair)).toEqual(['project_activated'])
  })

  it("ignores documents the live flow may still be mid-way through (< 30 min old) and ones older than the window", async () => {
    const db = createFakeSupabase({ ...healthy(), payment_milestones: [], sow_documents: [sow({ id: 'fresh', signed_at: ago(0.1) }), sow({ id: 'ancient', signed_at: ago(24 * 20) })] }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.sowsChecked).toBe(0); expect(r.repairs).toEqual([])
  })

  it("reports — but does not fabricate — the fingerprints it cannot honestly recreate (content_hash, frozen PDF)", async () => {
    const db = createFakeSupabase({ ...healthy(), sow_documents: [sow({ content_hash: null, pdf_path: null })] }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.unrepairable.join(' ')).toMatch(/without a content_hash/)
    expect(r.unrepairable.join(' ')).toMatch(/without a frozen executed PDF/)
    expect(db.tables.sow_documents[0].content_hash).toBeNull()
  })

  it('a repair that fails is recorded as a failure (and retried next run), and does not stop other documents', async () => {
    const db = createFakeSupabase({
      ...healthy(), payment_milestones: [],
      sow_documents: [sow({ id: 's1' }), sow({ id: 's2', project_id: 'p2', projects: project({ id: 'p2' }) })],
      project_scope_snapshot: [{ id: 'x', project_id: 'p1' }, { id: 'y', project_id: 'p2' }],
    }, { errors: [{ table: 'payment_milestones', op: 'insert', message: 'constraint', times: 1 }] }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatch(/create milestones/)
    expect(r.repairs.filter(x => x.repair === 'milestones_created')).toHaveLength(1) // the other document was still repaired
  })

  it('recreates a missing amendment for an accepted CO, from the same data the live flow uses', async () => {
    const db = createFakeSupabase({
      ...healthy(),
      change_orders: [{ id: 'c1', title: 'Extra pages', workspace_id: 'w1', project_id: 'p1', status: 'accepted', total: 1200, accepted_at: ago(5), content_hash: 'h', pdf_path: 'p', is_retainer_renewal: false,
        line_items: [{ description: '3 landing pages' }, { description: 'Negotiated discount', kind: 'adjustment' }], projects: { id: 'p1', name: 'Acme', type: 'fixed', deleted_at: null } }],
    }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.repairs).toEqual([{ kind: 'co', id: 'c1', repair: 'amendment_created' }])
    expect(db.tables.amendments[0]).toMatchObject({ change_order_id: 'c1', signed_sow_id: 's1', financial_impact: 1200, added_deliverables: ['3 landing pages'] })
    const again = await runSigningIntegrity(db.client)
    expect(again.repairs).toEqual([]); expect(db.tables.amendments).toHaveLength(1)
  })

  it("will not guess a retainer renewal's amendment (the replaced rate is gone) — it asks a human", async () => {
    const db = createFakeSupabase({
      ...healthy(),
      change_orders: [{ id: 'c1', title: 'Renewal', workspace_id: 'w1', project_id: 'p1', status: 'accepted', total: 6500, accepted_at: ago(5), content_hash: 'h', pdf_path: 'p', is_retainer_renewal: true, line_items: [], projects: { id: 'p1', name: 'Acme', type: 'retainer', deleted_at: null } }],
    }); h.db = db
    const r = await runSigningIntegrity(db.client)
    expect(r.repairs).toEqual([])
    expect(r.unrepairable.join(' ')).toMatch(/retainer renewal accepted with no amendment/)
    expect(db.tables.amendments).toHaveLength(0)
  })
})

describe('POST /api/cron/signing-integrity', () => {
  it('records a heartbeat with the counts, alerts once for things needing a human, and reports failures as row errors', async () => {
    h.db = createFakeSupabase({ ...healthy(), sow_documents: [sow({ content_hash: null })] })
    const res = await POST({} as any); const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sowsChecked: 1, repaired: 0, unrepairable: 1 })
    expect(body.rowErrors?.join(' ')).toMatch(/needs a human/)
    expect(h.alerts).toHaveLength(1); expect(h.heartbeats).toHaveLength(1)
  })

  it('is quiet (no alert) when there is nothing to do', async () => {
    h.db = createFakeSupabase(healthy())
    const res = await POST({} as any)
    expect(res.status).toBe(200); expect(h.alerts).toHaveLength(0)
  })

  it('a failed candidate query fails the run (500, alert, no heartbeat)', async () => {
    h.db = createFakeSupabase(healthy(), { errors: [{ table: 'sow_documents', op: 'select', message: 'db down' }] })
    const res = await POST({} as any)
    expect(res.status).toBe(500); expect(h.alerts).toHaveLength(1); expect(h.heartbeats).toHaveLength(0)
  })
})
