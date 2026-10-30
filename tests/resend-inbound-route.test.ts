// Behavioural test of POST /api/guardian/inbound with Resend as the provider (supabase + AI pipeline mocked).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  project: null as any, client: null as any, uploads: [] as any[], attachmentRows: [] as any[], inserted: [] as any[],
  classify: vi.fn(async () => ({ status: 'ok', classification: { outcome: 'in_scope' } })),
}))

function chain(result: () => any) {
  const c: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
      return () => c
    },
    apply() { return c },
  })
  return c
}
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'projects') return chain(() => ({ data: state.project ? [state.project] : [], error: null }))
      if (table === 'clients') return chain(() => ({ data: state.client, error: null }))
      if (table === 'guardian_check_attachments') return { insert: async (row: any) => { state.attachmentRows.push(row); return { error: null } } }
      if (table === 'guardian_checks') return {
        select: () => chain(() => ({ data: [], count: 0, error: null })),
        insert: (row: any) => { state.inserted.push(row); return chain(() => ({ data: { id: 'chk1' }, error: null })) },
      }
      return chain(() => ({ data: [], error: null }))
    },
    storage: { from: () => ({ upload: async (path: string, buf: Buffer, o: any) => { state.uploads.push({ path, size: buf.length, o }); return { error: null } }, remove: async () => ({}) }) },
  }),
}))
vi.mock('@/lib/ai/guardian-pipeline', () => ({
  classifyAndRecord: state.classify, findDuplicateCheck: async () => null, tryEmbedding: async () => null,
  GUARDIAN_SYSTEM_ACTOR: { email: 'g@x', name: 'Guardian' },
}))
vi.mock('@/lib/utils/rate-limit', () => ({ claimAiRateSlotByProject: async () => ({ allowed: true }) }))
vi.mock('@/lib/billing/plans', () => ({ isWorkspaceLapsed: () => false }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))

import { POST } from '@/app/api/guardian/inbound/route'

const RAW = 'route-test-secret'
const SECRET = 'whsec_' + Buffer.from(RAW).toString('base64')
function req(body: string, opts: { sign?: boolean; ts?: number } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.sign !== false) {
    headers['svix-id'] = 'msg_1'; headers['svix-timestamp'] = String(ts)
    headers['svix-signature'] = 'v1,' + createHmac('sha256', Buffer.from(RAW)).update(`msg_1.${ts}.${body}`).digest('base64')
  }
  return new NextRequest('http://localhost/api/guardian/inbound', { method: 'POST', headers, body })
}
const event = (data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'email.received', created_at: new Date().toISOString(),
  data: { email_id: 'em1', from: 'client@acme.com', to: ['proj-ab12cd34@guard.scopegov.app'], cc: [], bcc: [], received_for: [], subject: 'Request: add dark mode', ...data }, ...extra,
})
const PDF = Buffer.from('%PDF-1.4 test')
function mockResend(over: { email?: any; attachments?: any[]; emailStatus?: number } = {}) {
  const calls: string[] = []
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url); calls.push(u)
    if (u.includes('/attachments')) return new Response(JSON.stringify({ data: over.attachments ?? [] }))
    if (u.startsWith('https://api.resend.com/emails/receiving/')) {
      if (over.emailStatus) return new Response('{}', { status: over.emailStatus })
      return new Response(JSON.stringify({ text: 'Please add a dark mode to the dashboard.', html: null, headers: { from: 'Client <client@acme.com>' },
        message_id: '<rfc@acme>', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: over.attachments ?? [], ...over.email }))
    }
    return new Response(PDF)
  }) as any
  return calls
}
const json = async (r: Response) => r.json()
const realFetch = global.fetch

beforeEach(() => {
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET; process.env.RESEND_INBOUND_API_KEY = 're_in'
  state.project = { id: 'p1', name: 'Site', status: 'Active', stall_reason: null, workspace_id: 'w1', client_id: 'c1',
    workspaces: { deleted_at: null, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, guardian_sensitivity_tier: 'medium' },
    project_scope_snapshot: { deliverables: [], out_of_scope: [], last_updated_at: '2026-01-01T00:00:00Z' } }
  state.client = { email: 'client@acme.com', cc_emails: [] }
  state.uploads = []; state.attachmentRows = []; state.inserted = []; state.classify.mockClear()
})
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

describe('POST /api/guardian/inbound (Resend)', () => {
  it('503 when the inbound secret is not configured', async () => {
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET
    expect((await POST(req(event()))).status).toBe(503)
  })
  it('401 for a missing, forged or stale signature, with no Resend call', async () => {
    const calls = mockResend()
    expect((await POST(req(event(), { sign: false }))).status).toBe(401)
    expect((await POST(req(event(), { ts: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })
  it('ignores other event types and non-Guardian addresses without calling Resend', async () => {
    const calls = mockResend()
    expect((await json(await POST(req(JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } }))))).message).toMatch(/ignored/)
    expect((await json(await POST(req(event({ to: ['someone@else.com'] }))))).message).toMatch(/Not a Guardian address/)
    expect(calls).toHaveLength(0)
  })
  it('a Resend failure answers 500 and stores nothing (so Resend redelivers)', async () => {
    mockResend({ emailStatus: 502 })
    expect((await POST(req(event()))).status).toBe(500)
    expect(state.inserted).toHaveLength(0)
  })
  it('404 on a fresh event is retried (500); on an event over an hour old it is acknowledged', async () => {
    mockResend({ emailStatus: 404 })
    expect((await POST(req(event()))).status).toBe(500)
    const old = new Date(Date.now() - 2 * 3600_000).toISOString()
    const res = await POST(req(event({}, { created_at: old })))
    expect(res.status).toBe(200); expect((await json(res)).message).toMatch(/no longer available/)
  })
  it('skips automated mail (Auto-Submitted) without storing', async () => {
    mockResend({ email: { headers: { from: 'Bot <client@acme.com>', 'auto-submitted': 'auto-replied' } } })
    expect((await json(await POST(req(event())))).message).toMatch(/Automated/)
    expect(state.inserted).toHaveLength(0)
  })
  it('happy path: stores the check keyed by the Resend email id and classifies subject + body', async () => {
    mockResend()
    const res = await POST(req(event()))
    expect(res.status).toBe(200)
    const row = state.inserted[0]
    expect(row.source).toBe('email')
    expect(row.content).toContain('Subject: Request: add dark mode'); expect(row.content).toContain('dark mode to the dashboard')
    expect(row.source_metadata).toMatchObject({ message_id: 'em1', rfc_message_id: '<rfc@acme>', from_address: 'client@acme.com', sender_known: true, authentication: { dmarc: 'pass' } })
    expect(state.classify).toHaveBeenCalledTimes(1)
  })
  it('a known client address that FAILS DMARC is not treated as a known sender', async () => {
    mockResend({ email: { authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } } })
    await POST(req(event()))
    expect(state.inserted[0].source_metadata.sender_known).toBe(false)
  })
  it('a missing authentication result (null) does not demote a known client', async () => {
    mockResend({ email: { authentication: null } })
    await POST(req(event()))
    expect(state.inserted[0].source_metadata.sender_known).toBe(true)
  })
  it('downloads and stores an allowed attachment, skips an oversize one and a disallowed type', async () => {
    const att = (o: any) => ({ id: 'a1', filename: 'brief.pdf', content_type: 'application/pdf', size: PDF.length, download_url: 'https://files.example/a1', ...o })
    mockResend({ attachments: [att({}), att({ id: 'a2', filename: 'huge.pdf', size: 50 * 1024 * 1024 }), att({ id: 'a3', filename: 'x.exe', content_type: 'application/x-msdownload' })] })
    const res = await POST(req(event()))
    expect(res.status).toBe(200)
    expect(state.uploads).toHaveLength(1)
    expect(state.attachmentRows).toMatchObject([{ file_name: 'brief.pdf', check_id: 'chk1', mime_type: 'application/pdf' }])
    expect((global.fetch as any).mock.calls.filter((c: any) => String(c[0]).includes('files.example'))).toHaveLength(1)
  })
  it('an attachment that fails to download never fails the check', async () => {
    const calls = mockResend({ attachments: [{ id: 'a1', filename: 'brief.pdf', content_type: 'application/pdf', size: 10, download_url: 'https://files.example/a1' }] })
    const inner = global.fetch as any
    global.fetch = vi.fn(async (u: any, i: any) => String(u).includes('files.example') ? new Response('', { status: 403 }) : inner(u, i)) as any
    const res = await POST(req(event()))
    expect(res.status).toBe(200); expect(state.inserted).toHaveLength(1); expect(state.uploads).toHaveLength(0); void calls
  })
  it('a BCC\'d guard address (absent from `to`) still routes to the project', async () => {
    mockResend()
    const res = await POST(req(event({ to: ['someone@else.com'], bcc: ['proj-ab12cd34@guard.scopegov.app'] })))
    expect((await json(res)).ok).toBe(true); expect(state.inserted).toHaveLength(1)
  })
})
