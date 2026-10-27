import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ emitted: [] as any[], recipients: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('unused') } }))
vi.mock('@/lib/integrations/events', async (orig) => ({ ...(await orig<any>()), emitIntegrationEvent: async (input: any) => { h.emitted.push(input); return true } }))
vi.mock('@/lib/utils/permissions-query', async (orig) => ({ ...(await orig<any>()), getMembersWithPermission: async () => h.recipients }))

import { INTEGRATION_EVENT_MAP } from '@/lib/integrations/events'
import { EVENT_CATALOG, sampleEnvelope } from '@/lib/integrations/event-catalog'
import { DOCUMENT_SPECS, loadDocuments, withDocument } from '@/lib/integrations/enrich'
import { processDeliveries } from '@/lib/integrations/delivery'
import { encryptSecret } from '@/lib/integrations/crypto'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

const WS = '0f1e2d3c-4b5a-4968-8776-655443322110', OTHER = '11111111-2222-4333-8444-555555555555'
const PROJ = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'
const INV = '8a4d6f20-5b19-4e37-a6c2-1f0b9d8e7c53', SOW = '3c1f0a52-7d84-4b6e-9a21-5e0d8c7b4a10', MS = '2f7c1e96-4d03-4a8b-b5e1-9c6a0d3f8b27'

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : [])
const SOURCES = [...walk(path.join(__dirname, '..', 'app')), ...walk(path.join(__dirname, '..', 'lib'))]

describe('every mapped notification site supplies structured data (drift guard)', () => {
  const sites: { key: string; file: string; chunk: string }[] = []
  for (const f of SOURCES) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/notifyMembersWithPermission\(/g)) {
      const chunk = src.slice(m.index!, m.index! + 1500)
      const e = /eventType:\s*'([a-z_]+)'/.exec(chunk)
      if (e && INTEGRATION_EVENT_MAP[e[1]]) sites.push({ key: e[1], file: path.relative(path.join(__dirname, '..'), f), chunk })
    }
  }
  it('finds every site', () => { expect(sites.length).toBe(20) })
  const family: Record<string, string | null> = { sow: 'sow', co: 'change_order', guardian: 'guardian_flag', invoice: 'invoice', payment: 'payment_milestone', retainer: null }
  for (const s of sites) {
    it(`${s.key} (${s.file}) passes integrationData with the right document type`, () => {
      // Only this call's own object: stop at the call's closing "})" so a neighbouring call cannot satisfy the check.
      const call = s.chunk.slice(0, s.chunk.search(/\n\s*\}\)\s*\n/) > 0 ? s.chunk.search(/\n\s*\}\)\s*\n/) : s.chunk.length)
      expect(call, 'integrationData').toContain('integrationData')
      const want = family[s.key.split('_')[0] === 'co' ? 'co' : s.key.split('_')[0]]
      if (want) expect(call).toContain(`type: '${want}'`)
      else expect(call).toMatch(/retainer:/)
    })
  }
  it('the Guardian pipeline does not announce low-confidence borderline items (same policy as its email)', () => {
    const s = sites.find(x => x.file.endsWith('guardian-pipeline.ts'))!
    expect(s.chunk).toContain('skipIntegrations: isBorderline')
  })
})

describe('notify hook', () => {
  beforeEach(() => { h.emitted.length = 0; h.recipients = [] })
  const base = { workspaceId: WS, permission: 'SEND_SOW' as const, eventType: 'sow_signed', type: 'sow_signed', title: 'SOW signed — X', body: 'Jane signed.', entityType: 'project', entityId: PROJ, projectId: PROJ }
  it('passes structured facts through, but the bell text always wins', async () => {
    await notifyMembersWithPermission({} as any, { ...base, integrationData: { document: { type: 'sow', id: SOW }, signed_by: 'Jane', title: 'HIJACKED', summary: 'HIJACKED' } })
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0].data).toEqual({ document: { type: 'sow', id: SOW }, signed_by: 'Jane', title: 'SOW signed — X', summary: 'Jane signed.' })
  })
  it('skipIntegrations suppresses the announcement only', async () => {
    await notifyMembersWithPermission({} as any, { ...base, skipIntegrations: true })
    expect(h.emitted).toHaveLength(0)
  })
  it('announces even when nobody is eligible for the in-app row', async () => {
    h.recipients = []; await notifyMembersWithPermission({} as any, base); expect(h.emitted).toHaveLength(1)
  })
})

describe('document enrichment', () => {
  const ev = (over: any = {}) => ({ id: 'e1', workspace_id: WS, project_id: PROJ, event_type: 'invoice.paid', data: { document: { type: 'invoice', id: INV } }, ...over })
  const invoiceRow = { id: INV, workspace_id: WS, invoice_number: 'INV-0042', title: 'Milestone 1', status: 'paid', amount: '2500.00', amount_paid: 1000, currency: 'USD', due_date: '2026-02-07', sent_at: 's', paid_at: null,
    // columns that must NEVER be copied out:
    token: 'secret-portal-token', payment_instructions: 'IBAN GB00...', notes: 'private', client_email: 'a@b.com' }
  const run = async (tables: any, events: any[], cur = () => 'USD') => { const db = createFakeSupabase(tables); const idx = await loadDocuments(db.client, events, cur); return { idx, out: events.map(e => withDocument(e, idx)) } }

  it('shapes an invoice (numbers as numbers, computed balance) and copies nothing it was not asked for', async () => {
    const { out } = await run({ invoices: [invoiceRow] }, [ev()])
    expect(out[0].document).toEqual({ type: 'invoice', id: INV, number: 'INV-0042', title: 'Milestone 1', status: 'paid', amount: 2500, amount_paid: 1000, balance_due: 1500, currency: 'USD', due_date: '2026-02-07', sent_at: 's', paid_at: null })
    expect(JSON.stringify(out[0])).not.toMatch(/secret-portal-token|IBAN|private|a@b\.com/)
  })
  it("refuses a document that belongs to another workspace (falls back to the bare reference)", async () => {
    const { out } = await run({ invoices: [{ ...invoiceRow, workspace_id: OTHER }] }, [ev()])
    expect(out[0].document).toEqual({ type: 'invoice', id: INV })
  })
  it('a payment milestone must belong to the event\'s own project; currency comes from that project', async () => {
    const e = ev({ event_type: 'milestone.overdue', data: { document: { type: 'payment_milestone', id: MS } } })
    const row = { id: MS, project_id: PROJ, title: 'Design', amount: 1200, due_date: 'd', status: 'overdue', type: 'milestone' }
    expect((await run({ payment_milestones: [row] }, [e], () => 'EUR')).out[0].document).toMatchObject({ title: 'Design', amount: 1200, currency: 'EUR' })
    expect((await run({ payment_milestones: [{ ...row, project_id: 'other' }] }, [e])).out[0].document).toEqual({ type: 'payment_milestone', id: MS })
  })
  it('ignores unknown types and non-uuid ids without querying; keeps the call site\'s own facts', async () => {
    const db = createFakeSupabase({})
    const events = [ev({ data: { document: { type: 'users', id: INV }, x: 1 } }), ev({ data: { document: { type: 'invoice', id: 'nope' }, y: 2 } }), ev({ data: { z: 3 } })]
    const idx = await loadDocuments(db.client, events, () => null)
    expect(idx.size).toBe(0)
    expect(withDocument(events[0], idx)).toEqual({ document: { type: 'users', id: INV }, x: 1 })
    expect(withDocument(events[2], idx)).toEqual({ z: 3 })
  })
  it('a failed lookup never throws: the event goes out with the bare reference', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createFakeSupabase({ invoices: [invoiceRow] }, { errors: [{ table: 'invoices', op: 'select' }] })
    const events = [ev()]; const idx = await loadDocuments(db.client, events, () => null)
    expect(withDocument(events[0], idx).document).toEqual({ type: 'invoice', id: INV })
  })
  it('one query per document type, however many events', async () => {
    const db = createFakeSupabase({ invoices: [invoiceRow], sow_documents: [{ id: SOW, workspace_id: WS, document_number: 'SOW-1', version: 1, status: 'signed' }] })
    await loadDocuments(db.client, [ev({ id: 'a' }), ev({ id: 'b' }), ev({ id: 'c', data: { document: { type: 'sow', id: SOW } } })], () => null)
    const reads = db.calls.filter((c: any) => c.op === 'select').map((c: any) => c.table).sort()
    expect(reads).toEqual(['invoices', 'sow_documents'])
  })
})

describe('samples are honest', () => {
  it('every sample document uses only fields enrichment can really produce', () => {
    const rich: Record<string, any> = {
      sow: { id: 'i', workspace_id: 'w', document_number: 'n', version: 1, status: 's', sent_at: 'a', signed_at: 'b', expires_at: 'c' },
      change_order: { id: 'i', workspace_id: 'w', document_number: 'n', title: 't', version: 1, status: 's', total: 1, is_credit: false, is_retainer_renewal: false, sent_at: 'a', accepted_at: 'b', expires_at: 'c' },
      invoice: { id: 'i', workspace_id: 'w', invoice_number: 'n', title: 't', status: 's', amount: 1, amount_paid: 0, currency: 'USD', due_date: 'd', sent_at: 'a', paid_at: 'b' },
      payment_milestone: { id: 'i', project_id: 'p', title: 't', amount: 1, due_date: 'd', status: 's', type: 'x' },
      guardian_flag: { id: 'i', workspace_id: 'w', severity: 's', status: 's', type: 't', description: 'd', sow_reference: 'r', created_at: 'c' },
    }
    for (const e of EVENT_CATALOG) {
      const doc: any = (sampleEnvelope(e).data as any).document
      if (!doc) continue
      const real = { type: doc.type, id: 'x', ...DOCUMENT_SPECS[doc.type].shape(rich[doc.type], { currency: 'USD' }) }
      expect(Object.keys(doc).sort(), e.type).toEqual(Object.keys(real).sort())
    }
  })
  it('the document type of each sample matches the event family', () => {
    for (const e of EVENT_CATALOG) {
      const doc: any = (sampleEnvelope(e).data as any).document
      const f = e.type.split('.')[0]
      expect(doc?.type ?? null, e.type).toBe({ sow: 'sow', change_order: 'change_order', guardian: 'guardian_flag', invoice: 'invoice', milestone: 'payment_milestone', retainer: null }[f])
    }
  })
})

describe('end to end through the delivery worker', () => {
  it('a delivered payload carries the looked-up document alongside the site\'s own facts', async () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    const sealed = encryptSecret('whsec_t', `${WS}:sub-1`)
    const db = createFakeSupabase({
      integration_deliveries: [{ id: 'd1', workspace_id: WS, subscription_id: 'sub-1', event_id: 'ev-1', attempts: 1, status: 'delivering' }],
      integration_subscriptions: [{ id: 'sub-1', workspace_id: WS, kind: 'zapier', target_url: 'https://hooks.zapier.com/hooks/standard/1/a/', secret_enc: sealed, active: true, consecutive_failures: 0 }],
      integration_events: [{ id: 'ev-1', workspace_id: WS, event_type: 'invoice.paid', entity_type: 'project', entity_id: PROJ, project_id: PROJ, created_at: 'now',
        data: { title: 'Invoice paid', summary: 's', document: { type: 'invoice', id: INV }, payment: { amount: 1000, method: 'cash' }, fully_paid: false } }],
      workspaces: [{ id: WS, plan_tier: 'starter', trial_ends_at: null, lapsed_at: null, deleted_at: null }],
      projects: [{ id: PROJ, name: 'Site', status: 'Active', currency: 'USD', client_id: 'c', clients: { id: 'c', name: 'Acme' } }],
      invoices: [{ id: INV, workspace_id: WS, invoice_number: 'INV-0042', title: 'M1', status: 'partially_paid', amount: 2500, amount_paid: 1000, currency: 'USD', due_date: 'd', sent_at: 's', paid_at: null }],
    }, { rpc: { claim_integration_deliveries: () => ({ data: [{ id: 'd1', workspace_id: WS, subscription_id: 'sub-1', event_id: 'ev-1', attempts: 1 }] }) } })
    const send = vi.fn(async () => ({ status: 200, retryAfter: null }))
    await processDeliveries(db.client, { send })
    const sent = JSON.parse((send.mock.calls[0] as any)[1].body)
    expect(sent.project).toEqual({ id: PROJ, name: 'Site', status: 'Active', currency: 'USD' })
    expect(sent.data.document).toMatchObject({ type: 'invoice', number: 'INV-0042', amount: 2500, balance_due: 1500, status: 'partially_paid' })
    expect(sent.data).toMatchObject({ payment: { amount: 1000, method: 'cash' }, fully_paid: false, title: 'Invoice paid' })
  })
})

describe('schema drift guard: every column enrichment reads exists in the migrations', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations')
  const sql = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  const columnsOf = (table: string) => {
    const cols = new Set<string>()
    for (const m of sql.matchAll(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'g')))
      for (const line of m[1].split('\n')) { const c = /^\s*([a-z_]+)\s+[a-zA-Z]/.exec(line); if (c && !['constraint', 'primary', 'unique', 'check', 'foreign'].includes(c[1])) cols.add(c[1]) }
    for (const m of sql.matchAll(new RegExp(`ALTER TABLE (?:ONLY )?public\\.${table}\\s+([\\s\\S]*?);`, 'g')))
      for (const a of m[1].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_]+)/g)) cols.add(a[1])
    return cols
  }
  for (const [type, spec] of Object.entries(DOCUMENT_SPECS)) {
    it(`${spec.table} (${type})`, () => {
      const have = columnsOf(spec.table)
      expect(have.size, 'parsed some columns').toBeGreaterThan(5)
      const wanted = spec.select.split(',').map(c => c.trim())
      expect(wanted.filter(c => !have.has(c)), 'missing columns').toEqual([])
    })
  }
  it('projects.currency / name / status (project context in every payload)', () => {
    const have = columnsOf('projects'); for (const c of ['id', 'name', 'status', 'currency', 'client_id']) expect(have.has(c), c).toBe(true)
  })
})
