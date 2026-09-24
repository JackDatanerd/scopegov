import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], notified: [] as any[], emails: [] as any[], invoice: null as any,
  rateAllowed: true, notifyThrows: false, alerts: [] as any[],
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({
  logAudit: async (_s: any, p: any) => { h.audits.push({ event_type: p.eventType, ...p }) },
  insertAuditRow: async (_s: any, row: any) => { h.audits.push(row); return true },
}))
vi.mock('@/lib/utils/notify', () => ({
  notifyMembersWithPermission: async (_s: any, p: any) => { if (h.notifyThrows) throw new Error('notify exploded'); h.notified.push(p) },
}))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => ['fin@agency.test'] }))
vi.mock('@/lib/email/templates', () => ({
  sendInvoicePaymentClaimedEmail: async (p: any) => { h.emails.push(['claimed', p]) },
  sendInvoiceDisputedEmail: async (p: any) => { h.emails.push(['disputed', p]) },
  sendClientResponseReceivedEmail: async (p: any) => { h.emails.push(['receipt', p]); return { ok: true } },
  sendSowSignedAgencyEmail: async (p: any) => { h.emails.push(['signed-agency', p]) },
  sendSowSignedClientEmail: async (p: any) => { h.emails.push(['signed-client', p]) },
}))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async (fn: any) => { const r = await fn(); return { ok: r?.ok !== false } } }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => null }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: async () => [] }))
vi.mock('@/lib/utils/portal-rate-limit', () => ({
  checkPortalRateLimit: async () => (h.rateAllowed ? { allowed: true } : { allowed: false, message: 'Too many requests' }),
  recordPortalAction: async () => {},
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '203.0.113.5' }))
vi.mock('@/lib/documents/invoice-token', () => ({
  resolveInvoiceToken: async () => (h.invoice ? { ok: true, invoice: h.invoice } : { ok: false, error: 'This link is no longer valid', status: 410 }),
}))
vi.mock('@/lib/utils/workspace-secret', () => ({ getWorkspaceJwtSecret: async () => 'test-secret-test-secret-test-secret', isWorkspaceDeleted: async () => false }))
vi.mock('@/app/api/portal/sow/[token]/_shared', () => ({ checkRevokedToken: async () => ({ revoked: false }), verifySowJwt: async () => true }))
vi.mock('@/lib/pdf/renderer', () => ({ renderSowPdf: async () => Buffer.from('%PDF-fake') }))
vi.mock('@/lib/documents/executed-pdf', async () => {
  const real: any = await vi.importActual('@/lib/documents/executed-pdf')
  return { ...real, storeExecutedPdf: async () => 'w1/sow/s1.pdf' }
})
vi.mock('@/lib/utils/signature', () => ({ isValidSignatureImage: () => true }))

import { POST as paid } from '@/app/api/portal/invoice/[token]/paid/route'
import { POST as dispute } from '@/app/api/portal/invoice/[token]/dispute/route'
import { POST as sign } from '@/app/api/portal/sow/[token]/sign/route'

const req = (body: any) => ({ json: async () => body, headers: { get: () => null } }) as any
const ctx = { params: Promise.resolve({ token: 'tok' }) }
const run = async (fn: any, body: any) => { const res = await fn(req(body), ctx); return { status: res.status, body: await res.json() } }
const inv = (over: Row = {}) => ({
  id: 'i1', title: 'Deposit', invoice_number: 'INV-7', status: 'overdue', amount: 1500, amount_paid: 500, currency: 'USD',
  workspace_id: 'w1', project_id: 'p1', disputed_at: null, dispute_note: null, dispute_resolved_at: null,
  payment_claimed_at: null, payment_claim_cleared_at: null,
  projects: { id: 'p1', name: 'Acme site', client_id: 'c1', clients: { name: 'Acme', email: 'pay@acme.test', cc_emails: [] }, workspaces: { agency_name: 'Studio', brand_colour: '#123456' } }, ...over,
})

beforeEach(() => {
  h.audits.length = 0; h.notified.length = 0; h.emails.length = 0; h.alerts.length = 0
  h.rateAllowed = true; h.notifyThrows = false; h.invoice = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe("POST /api/portal/invoice/[token]/paid — the client's \"I've paid\" notice", () => {
  it('records the claim, audits, notifies finance in-app and by email — and does NOT touch status or amount_paid', async () => {
    h.invoice = inv(); h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'overdue', amount_paid: 500 }] })
    const { status, body } = await run(paid, { reference: ' TXN-991 ', note: 'Paid by bank transfer on Friday' })
    expect(status).toBe(200); expect(body.ok).toBe(true)
    const row = h.db.tables.invoices[0]
    expect(row).toMatchObject({ payment_claim_reference: 'TXN-991', payment_claim_note: 'Paid by bank transfer on Friday', payment_claim_cleared_at: null, status: 'overdue', amount_paid: 500 })
    expect(row.payment_claimed_at).toBeTruthy()
    expect(h.audits.map(a => a.event_type)).toContain('invoice.payment_claimed')
    expect(h.notified[0]).toMatchObject({ permission: 'VIEW_FINANCIALS', eventType: 'invoice_payment_claimed' })
    expect(h.emails[0][1]).toMatchObject({ balanceDue: 1000, reference: 'TXN-991' })
  })

  it('an already-open claim is acknowledged, not re-announced (double-click / replayed POST)', async () => {
    h.invoice = inv({ payment_claimed_at: '2026-01-01T00:00:00.000Z', payment_claim_cleared_at: null })
    h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'overdue' }] })
    const { body } = await run(paid, {})
    expect(body).toMatchObject({ ok: true, duplicate: true })
    expect(h.notified).toHaveLength(0); expect(h.emails).toHaveLength(0)
  })

  it("a claim the agency already answered (a payment was recorded after it) can be raised again for the remaining balance", async () => {
    h.invoice = inv({ payment_claimed_at: '2026-01-01T00:00:00.000Z', payment_claim_cleared_at: '2026-01-05T00:00:00.000Z', status: 'partially_paid' })
    h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'partially_paid' }] })
    const { body } = await run(paid, {})
    expect(body.duplicate).toBeUndefined(); expect(h.notified).toHaveLength(1)
  })

  it('refuses a paid or void invoice', async () => {
    h.db = createFakeSupabase({ invoices: [{ id: 'i1' }] })
    h.invoice = inv({ status: 'paid' }); expect((await run(paid, {})).status).toBe(409)
    h.invoice = inv({ status: 'void' }); expect((await run(paid, {})).status).toBe(409)
    expect(h.notified).toHaveLength(0)
  })

  it('rejects non-text fields, honours the rate limit, and rejects a dead link', async () => {
    h.invoice = inv(); h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'overdue' }] })
    expect((await run(paid, { reference: { a: 1 } })).status).toBe(400)
    h.rateAllowed = false; expect((await run(paid, {})).status).toBe(429)
    h.rateAllowed = true; h.invoice = null; expect((await run(paid, {})).status).toBe(410)
  })

  it('strips markup from the free text and caps its length', async () => {
    h.invoice = inv(); h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'overdue' }] })
    await run(paid, { reference: '<script>alert(1)</script>REF-1', note: 'x'.repeat(5000) })
    const row = h.db.tables.invoices[0]
    expect(row.payment_claim_reference).not.toMatch(/<script/i)
    expect(row.payment_claim_note.length).toBeLessThanOrEqual(1000)
  })

  it('a failed write is a 500 and notifies nobody', async () => {
    h.invoice = inv(); h.db = createFakeSupabase({ invoices: [{ id: 'i1', status: 'overdue' }] }, { errors: [{ table: 'invoices', op: 'update', message: 'boom' }] })
    expect((await run(paid, {})).status).toBe(500); expect(h.notified).toHaveLength(0)
  })
})

describe('POST /api/portal/invoice/[token]/dispute — per-invoice throttle', () => {
  const note = 'The second line item does not match what we agreed'

  it('first dispute is recorded and notifies; the SAME message re-sent while open is acknowledged silently', async () => {
    h.invoice = inv(); h.db = createFakeSupabase({ invoices: [{ id: 'i1' }] })
    expect((await run(dispute, { note })).status).toBe(200)
    expect(h.notified).toHaveLength(1)
    h.invoice = inv({ disputed_at: new Date().toISOString(), dispute_note: note })
    const again = await run(dispute, { note })
    expect(again.body).toMatchObject({ ok: true, duplicate: true })
    expect(h.notified).toHaveLength(1) // no second page to finance, no second client receipt
  })

  it('a DIFFERENT message within 15 minutes is throttled (429), after 15 minutes it is accepted', async () => {
    h.db = createFakeSupabase({ invoices: [{ id: 'i1' }] })
    h.invoice = inv({ disputed_at: new Date(Date.now() - 2 * 60_000).toISOString(), dispute_note: 'first message here' })
    expect((await run(dispute, { note })).status).toBe(429)
    expect(h.notified).toHaveLength(0)
    h.invoice = inv({ disputed_at: new Date(Date.now() - 20 * 60_000).toISOString(), dispute_note: 'first message here' })
    expect((await run(dispute, { note })).status).toBe(200)
    expect(h.notified).toHaveLength(1)
  })

  it('once the agency has resolved it, a fresh dispute is always allowed', async () => {
    h.db = createFakeSupabase({ invoices: [{ id: 'i1' }] })
    h.invoice = inv({ disputed_at: new Date().toISOString(), dispute_note: note, dispute_resolved_at: new Date().toISOString() })
    expect((await run(dispute, { note })).status).toBe(200)
  })
})

describe('POST /api/portal/sow/[token]/sign — post-commit resilience', () => {
  const dbFor = (extra: Record<string, Row[]> = {}, opts: any = {}) => createFakeSupabase({
    sow_documents: [{
      id: 's1', version: 1, status: 'awaiting_signature', expires_at: '2999-01-01T00:00:00.000Z', project_id: 'p1', workspace_id: 'w1', document_number: 'SOW-1',
      token: 'tok', sections: [{ id: 'deliverables', table: [{ deliverable: 'Homepage' }] }], metadata: { paymentStructure: '100_upfront' },
      projects: {
        id: 'p1', name: 'Acme site', disc: null, currency: 'USD', contract_value: 4000, client_id: 'c1', created_by: 'u1', guardian_email: null,
        clients: { name: 'Acme', email: 'pay@acme.test', cc_emails: [], company_name: null, billing_address: null, vat_number: null },
        workspaces: { id: 'w1', agency_name: 'Studio', brand_colour: '#123456', logo_storage_path: null, agency_signature_data: null, first_sow_signed_at: '2025-01-01', legal_address: null, tax_id: null, phone: null, website: null },
      },
    }],
    projects: [{ id: 'p1', status: 'Awaiting Signature', stall_reason: null, guardian_email: null }],
    payment_milestones: [], project_scope_snapshot: [], revoked_tokens: [], workspaces: [{ id: 'w1', first_sow_signed_at: '2025-01-01' }], ...extra,
  }, opts)
  const signBody = { signerName: 'Pat Client', signatureData: 'data:image/png;base64,AAAA' }

  it('signs, activates the project, creates the milestone and Guardian baseline, and issues a fresh long-lived token', async () => {
    h.db = dbFor()
    const { status, body } = await run(sign, signBody)
    expect(status).toBe(200); expect(body.ok).toBe(true)
    expect(h.db.tables.sow_documents[0]).toMatchObject({ status: 'signed', signed_by: 'Pat Client' })
    expect(h.db.tables.projects[0].status).toBe('Active')
    expect(h.db.tables.payment_milestones).toHaveLength(1)
    expect(h.db.tables.project_scope_snapshot[0].deliverables).toEqual([{ title: 'Homepage' }])
    expect(body.guardianEmail).toMatch(/^proj-/)
    expect(body.token).not.toBe('tok')
    expect(h.db.tables.revoked_tokens[0]).toMatchObject({ token: 'tok', reason: 'superseded' })
  })

  it('a step that throws AFTER the signature was recorded no longer tells the client "please try again"', async () => {
    h.db = dbFor(); h.notifyThrows = true
    const { status, body } = await run(sign, signBody)
    expect(status).toBe(200); expect(body.ok).toBe(true)                      // was 500 — and the retry then hit 409
    expect(h.db.tables.sow_documents[0].status).toBe('signed')
    expect(h.audits.map(a => a.event_type)).toContain('sow.post_signing_failed') // findable, and repaired by the integrity sweep
  })

  it('a failing project-activation write is retried once, then recorded (the integrity sweep repairs it)', async () => {
    h.db = dbFor({}, { errors: [{ table: 'projects', op: 'update', message: 'rls', when: (p: any) => p?.status === 'Active' }] })
    const { status } = await run(sign, signBody)
    expect(status).toBe(200)
    expect(h.db.tables.sow_documents[0].status).toBe('signed')
    expect(h.db.tables.projects[0].status).toBe('Awaiting Signature')
    expect(h.audits.map(a => a.event_type)).toContain('sow.project_activation_failed')
    expect(h.db.calls.filter((c: any) => c.table === 'projects' && c.op === 'update' && c.payload?.status === 'Active')).toHaveLength(2)
  })

  it('a transient activation failure that succeeds on the retry needs no repair', async () => {
    h.db = dbFor({}, { errors: [{ table: 'projects', op: 'update', message: 'blip', times: 1, when: (p: any) => p?.status === 'Active' }] })
    await run(sign, signBody)
    expect(h.db.tables.projects[0].status).toBe('Active')
    expect(h.audits.map(a => a.event_type)).not.toContain('sow.project_activation_failed')
  })

  it("if the token-reissue write fails the client's link stays the ORIGINAL (a link pointing at nothing is worse)", async () => {
    h.db = dbFor({}, { errors: [{ table: 'sow_documents', op: 'update', message: 'blip', when: (p: any) => 'token' in (p || {}) && p.token }] })
    const { body } = await run(sign, signBody)
    expect(body.token).toBe('tok')
    expect(h.db.tables.revoked_tokens).toHaveLength(0)
    expect(h.db.tables.sow_documents[0].token).toBe('tok')
  })
})
