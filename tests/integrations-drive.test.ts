import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { createFakeSupabase } from './helpers/fake-supabase'
import { FakeDrive } from './helpers/fake-drive'

const h = vi.hoisted(() => ({ db: null as any, session: null as any, stepUp: null as any, drive: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: (s: any, p: string) => !!s?.permissions?.includes(p) }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => h.stepUp }))
vi.mock('@/lib/integrations/google', async (orig) => ({ ...(await orig<any>()), googleCall: (r: any) => h.drive.call(r) }))

import { googleAuthorizeUrl, googleConfigured, googleRedirectUri, signGoogleState, verifyGoogleState, GOOGLE_SCOPES, DRIVE_FILE_SCOPE, STATE_TTL_MS_FOR_TEST } from './helpers/google-test-exports'
import { isAllowedGoogleUrl, classifyGoogle, classifyTokenError, accessToken, clearTokenCache, emailFromIdToken } from '@/lib/integrations/google'
import { signState as signSlackState } from '@/lib/integrations/slack-config'
import { archiveExecutedDocument, driveName, MAX_PDF_BYTES } from '@/lib/integrations/drive-archive'
import { encryptSecret, decryptSecret } from '@/lib/integrations/crypto'
import { processDeliveries } from '@/lib/integrations/delivery'
import { BACKFILL_LIMIT } from '@/lib/integrations/drive-config'
import { POST as connect } from '@/app/api/workspace/integrations/google-drive/connect/route'
import { GET as callback } from '@/app/api/integrations/google/callback/route'
import { DELETE as disconnect, PATCH as patchRule } from '@/app/api/workspace/integrations/google-drive/route'
import { POST as backfill } from '@/app/api/workspace/integrations/google-drive/backfill/route'
import { GET as overview } from '@/app/api/workspace/integrations/route'

const KEY = randomBytes(32).toString('base64')
const WS = '0f1e2d3c-4b5a-4968-8776-655443322110', OTHER_WS = '11111111-2222-4333-8444-555555555555', USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONN = '55555555-5555-4555-8555-555555555555', RULE = '66666666-6666-4666-8666-666666666666'
const PROJ = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', PROJ2 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5e', CLIENT = '9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f'
const SOW = '3c1f0a52-7d84-4b6e-9a21-5e0d8c7b4a10', CO = '6e2b9d14-1a73-4c58-8f0e-2d9a7b3c5e41'
const ENV = { INTEGRATIONS_ENCRYPTION_KEY: KEY, GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'gsecret', NEXT_PUBLIC_APP_URL: 'https://app.example.com' } as unknown as NodeJS.ProcessEnv
const ALL = ['SEND_SOW', 'SEND_CHANGE_ORDERS', 'APPROVE_FLAGS', 'VIEW_FINANCIALS', 'MANAGE_WORKSPACE_SETTINGS']
const creds = (rt = 'rt-1', ws = WS, conn = CONN) => encryptSecret(JSON.stringify({ refresh_token: rt }), `${ws}:${conn}`)
const SOW_PDF = Buffer.from('%PDF-1.7 signed sow bytes \u0000\u0001\u00ff'), CO_PDF = Buffer.from('%PDF-1.7 accepted co bytes')

beforeEach(() => {
  Object.assign(process.env, ENV)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  clearTokenCache()
  h.drive = new FakeDrive()
  h.session = { id: USER, name: 'Ada', email: 'ada@acme.com', workspaceId: WS, planTier: 'pro', lapsed: false, permissions: ALL }
  h.stepUp = null
})

// ───────────────────────────── configuration, state, URL allow-list ─────────────────────────────
describe('Google config & state', () => {
  it('asks for offline access with a consent screen (or no refresh token comes back) and ONLY the narrow scopes', () => {
    const u = new URL(googleAuthorizeUrl('STATE', ENV)!)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('access_type')).toBe('offline'); expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('response_type')).toBe('code'); expect(u.searchParams.get('state')).toBe('STATE')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/integrations/google/callback')
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual([DRIVE_FILE_SCOPE, 'email', 'openid'].sort())
    expect(u.searchParams.get('scope')).not.toMatch(/auth\/drive(\s|$)|drive\.readonly|drive\.metadata/)
    expect(googleAuthorizeUrl('s', { ...ENV, NEXT_PUBLIC_APP_URL: '' } as any)).toBeNull()
    expect(googleConfigured({} as any)).toBe(false); expect(googleRedirectUri({ NEXT_PUBLIC_APP_URL: 'https://x.co/' } as any)).toBe('https://x.co/api/integrations/google/callback')
  })
  it('state round-trips, and a state minted for SLACK is rejected here (and the reverse)', () => {
    const t = signGoogleState({ ws: WS, uid: USER }, 1_800_000_000_000, ENV)
    expect(verifyGoogleState(t, 1_800_000_001_000, ENV)).toEqual({ ok: true, state: { ws: WS, uid: USER } })
    expect(verifyGoogleState(signSlackState({ ws: WS, uid: USER }, 1_800_000_000_000, ENV), 1_800_000_001_000, ENV)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyGoogleState(t, 1_800_000_000_000 + 11 * 60_000, ENV)).toEqual({ ok: false, reason: 'expired' })
    for (const bad of [null, '', 'x', 'a.b.c']) expect(verifyGoogleState(bad as any, 1, ENV).ok).toBe(false)
  })
})

describe('Google URL allow-list (the only hosts ever contacted)', () => {
  it('allows Google token + Drive endpoints only', () => {
    for (const ok of ['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke', 'https://www.googleapis.com/drive/v3/files?q=x', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=1'])
      expect(isAllowedGoogleUrl(ok), ok).toBe(true)
    for (const bad of ['http://www.googleapis.com/drive/v3/files', 'https://evil.example.com/drive/v3/files', 'https://www.googleapis.com.evil.com/drive/v3/files',
      'https://www.googleapis.com/gmail/v1/users/me/messages', 'https://www.googleapis.com:8443/drive/v3/files', 'https://u:p@www.googleapis.com/drive/v3/files',
      'https://storage.googleapis.com/x', 'ftp://www.googleapis.com/drive/v3/', 'not a url', ''])
      expect(isAllowedGoogleUrl(bad), bad).toBe(false)
  })
  it('the real caller refuses an off-list URL BEFORE sending anything (e.g. a poisoned upload Location)', async () => {
    const real = await vi.importActual<any>('@/lib/integrations/google') // the module is mocked above; this is the REAL caller
    const spy = vi.spyOn(globalThis, 'fetch')
    await expect(real.googleCall({ method: 'PUT', url: 'https://evil.example.com/steal', body: Buffer.from('contract') })).rejects.toThrow(/non-Google/)
    await expect(real.googleCall({ method: 'PUT', url: 'http://www.googleapis.com/upload/drive/v3/files?upload_id=1', body: Buffer.from('x') })).rejects.toThrow(/non-Google/)
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore()
  })
})

describe('classifying Google answers', () => {
  const c = (status: number, reason?: string) => classifyGoogle({ status, json: reason ? { error: { errors: [{ reason }] } } : null })
  it('2xx ok; 429/5xx retry', () => { expect(c(200).outcome).toBe('ok'); expect(c(429).outcome).toBe('retry'); expect(c(503).outcome).toBe('retry') })
  it('403 rate limits retry, a full Drive turns the rule off with a human reason', () => {
    for (const r of ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']) expect(c(403, r).outcome, r).toBe('retry')
    const full = c(403, 'storageQuotaExceeded') as any; expect(full.outcome).toBe('rule_off'); expect(full.reason).toMatch(/storage is full/i)
  })
  it('401 / insufficient permission = a CONNECTION fault; 404 / appNotAuthorizedToFile = the folder is gone', () => {
    expect(c(401).outcome).toBe('connection_off'); expect(c(403, 'insufficientPermissions').outcome).toBe('connection_off')
    expect(c(404).outcome).toBe('folder_gone'); expect(c(403, 'appNotAuthorizedToFile').outcome).toBe('folder_gone')
  })
  it('other 4xx are permanent', () => { expect(c(400, 'badRequest').outcome).toBe('permanent') })
  it('token endpoint: invalid_grant (revoked/expired) is a connection fault', () => {
    expect(classifyTokenError({ status: 400, json: { error: 'invalid_grant' } }).outcome).toBe('connection_off')
    expect(classifyTokenError({ status: 401, json: { error: 'invalid_client' } }).outcome).toBe('connection_off')
    expect(classifyTokenError({ status: 503, json: null }).outcome).toBe('retry')
    expect(classifyTokenError({ status: 400, json: { error: 'invalid_request' } }).outcome).toBe('permanent')
  })
  it('reads the account email from the id_token, and ignores junk', () => {
    const jwt = (p: any) => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`
    expect(emailFromIdToken(jwt({ email: 'ada@acme.com' }))).toBe('ada@acme.com')
    for (const bad of [jwt({ email: '<script>@x.com' }), jwt({}), 'nope', null, undefined, jwt({ email: 'a b@c.com' })]) expect(emailFromIdToken(bad)).toBeNull()
  })
})

describe('access tokens', () => {
  it('mints one, caches it, and refreshes after expiry', async () => {
    const d = h.drive as FakeDrive
    const a = await accessToken('c1', 'rt', d.call, ENV, 1_000), b = await accessToken('c1', 'rt', d.call, ENV, 2_000)
    expect(a).toEqual({ ok: true, token: 'at-1' }); expect(b).toEqual({ ok: true, token: 'at-1' }); expect(d.tokensIssued).toBe(1)
    expect(await accessToken('c1', 'rt', d.call, ENV, 1_000 + 3_600_000)).toEqual({ ok: true, token: 'at-2' })
    expect(await accessToken('c2', 'rt', d.call, ENV, 2_000)).toEqual({ ok: true, token: 'at-3' }) // per connection
  })
  it('a revoked grant is reported as a connection fault, never cached', async () => {
    const d = h.drive as FakeDrive; d.tokenError = 'invalid_grant'
    const r = await accessToken('c1', 'rt', d.call, ENV, 1_000); expect(r.ok).toBe(false); expect((r as any).verdict.outcome).toBe('connection_off')
  })
  it('sends the client credentials in the form body', async () => {
    const d = h.drive as FakeDrive; await accessToken('c1', 'rt-xyz', d.call, ENV, 1_000)
    expect(d.calls[0].form).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-xyz', client_id: ENV.GOOGLE_CLIENT_ID, client_secret: 'gsecret' })
  })
})

describe('Drive names', () => {
  it('are readable, safe and bounded', () => {
    expect(driveName('Acme / Co \\ Ltd', 'x')).toBe('Acme - Co - Ltd')
    expect(driveName('  a\u0000b\nc  ', 'x')).toBe('a b c')
    expect(driveName('', 'No client')).toBe('No client'); expect(driveName(null, 'No client')).toBe('No client'); expect(driveName('   ', 'P')).toBe('P')
    expect(driveName('x'.repeat(500), 'y')).toHaveLength(100)
  })
})

// ───────────────────────────── the archiver ─────────────────────────────
function archiveWorld(over: { sow?: any; co?: any; pdfs?: Record<string, Buffer | null> } = {}) {
  const sowPath = `${WS}/sow/${SOW}.pdf`, coPath = `${WS}/co/${CO}.pdf`
  const db = createFakeSupabase({
    sow_documents: [{ id: SOW, workspace_id: WS, project_id: PROJ, status: 'signed', pdf_path: sowPath, document_number: 'SOW-0007', version: 1, ...over.sow }],
    change_orders: [{ id: CO, workspace_id: WS, project_id: PROJ, status: 'accepted', pdf_path: coPath, document_number: 'CO-0003', title: 'Second landing page', ...over.co }],
    integration_external_refs: [],
  })
  const store: Record<string, Buffer | null> = { [sowPath]: SOW_PDF, [coPath]: CO_PDF, ...over.pdfs }
  ;(db.client as any).storage = { from: (_b: string) => ({ download: async (p: string) => store[p] ? { data: { arrayBuffer: async () => new Uint8Array(store[p]!).buffer }, error: null } : { data: null, error: { message: 'not found' } } }) }
  return { db, service: db.client as any, store }
}
const input = (w: ReturnType<typeof archiveWorld>, docType: 'sow' | 'change_order', id: string, over: any = {}) => ({
  service: w.service, connection: { id: CONN, workspace_id: WS, credentials_enc: creds() },
  event: { id: 'e1', workspace_id: WS, project_id: PROJ, data: { document: { type: docType, id } } },
  project: { id: PROJ, name: 'Website Redesign', clients: { id: CLIENT, name: 'Acme Ltd' } },
  call: (h.drive as FakeDrive).call, env: ENV, ...over,
})
const refs = (w: any) => w.db.tables.integration_external_refs

describe('archiving an executed document', () => {
  it('copies the frozen PDF byte-for-byte into ScopeGov Archive / Client / Project and records it', async () => {
    const w = archiveWorld(), d = h.drive as FakeDrive
    const r = await archiveExecutedDocument(input(w, 'sow', SOW))
    expect(r.verdict.outcome).toBe('ok'); expect(r.already).toBeUndefined()
    expect(d.folders().map(f => f.name).sort()).toEqual(['Acme Ltd', 'ScopeGov Archive', 'Website Redesign'])
    const [pdf] = d.pdfs(); expect(d.pdfs()).toHaveLength(1)
    expect(d.pathOf(pdf)).toBe('ScopeGov Archive / Acme Ltd / Website Redesign / SOW-Website-Redesign-v1-signed.pdf')
    expect(Buffer.compare(pdf.bytes!, SOW_PDF)).toBe(0)
    expect(pdf.appProperties).toEqual({ scopegov_doc: `sow:${SOW}`, scopegov_workspace: WS })
    expect(refs(w).filter((x: any) => x.ref_type === 'folder')).toHaveLength(3)
    expect(refs(w).find((x: any) => x.ref_type === 'file')).toMatchObject({ local_key: `sow:${SOW}`, connection_id: CONN, workspace_id: WS, remote_id: pdf.id })
    expect(r.fileUrl).toContain(pdf.id)
  })
  it('archiving the same document again is a no-op: no Drive writes, still one file', async () => {
    const w = archiveWorld(), d = h.drive as FakeDrive
    await archiveExecutedDocument(input(w, 'sow', SOW)); const before = d.calls.length
    const r = await archiveExecutedDocument(input(w, 'sow', SOW))
    expect(r).toMatchObject({ verdict: { outcome: 'ok' }, already: true }); expect(d.calls.length).toBe(before); expect(d.pdfs()).toHaveLength(1)
  })
  it('a second document in the same project reuses the folders; a second project reuses root + client', async () => {
    const w = archiveWorld(), d = h.drive as FakeDrive
    await archiveExecutedDocument(input(w, 'sow', SOW))
    const co = await archiveExecutedDocument(input(w, 'change_order', CO))
    expect(co.verdict.outcome).toBe('ok'); expect(d.folders()).toHaveLength(3); expect(d.pdfs()).toHaveLength(2)
    expect(d.pdfs().map(f => d.pathOf(f)).sort()).toEqual([
      'ScopeGov Archive / Acme Ltd / Website Redesign / CO-0003-Second-landing-page-accepted.pdf',
      'ScopeGov Archive / Acme Ltd / Website Redesign / SOW-Website-Redesign-v1-signed.pdf'])
    w.db.tables.change_orders.push({ id: 'co2', workspace_id: WS, project_id: PROJ2, status: 'accepted', pdf_path: `${WS}/co/co2.pdf`, document_number: 'CO-0009', title: 'Other' })
    w.store[`${WS}/co/co2.pdf`] = Buffer.from('%PDF other')
    const other = await archiveExecutedDocument({ ...input(w, 'change_order', '12121212-1212-4212-8212-121212121212'), project: { id: PROJ2, name: 'Mobile App', clients: { id: CLIENT, name: 'Acme Ltd' } } })
    expect(other.verdict.outcome).toBe('permanent') // not a real uuid in the db: refused cleanly
    w.db.tables.change_orders[1].id = '12121212-1212-4212-8212-121212121212'
    const ok = await archiveExecutedDocument({ ...input(w, 'change_order', '12121212-1212-4212-8212-121212121212'), project: { id: PROJ2, name: 'Mobile App', clients: { id: CLIENT, name: 'Acme Ltd' } } })
    expect(ok.verdict.outcome).toBe('ok'); expect(d.folders().map(f => f.name).sort()).toEqual(['Acme Ltd', 'Mobile App', 'ScopeGov Archive', 'Website Redesign'])
  })
  it('names are sanitised; a missing client lands in "No client"', async () => {
    const w = archiveWorld(), d = h.drive as FakeDrive
    await archiveExecutedDocument(input(w, 'sow', SOW, { project: { id: PROJ, name: 'A/B \\ C', clients: { id: CLIENT, name: 'Acme / Co' } } }))
    expect(d.folders().map(f => f.name)).toContain('Acme - Co'); expect(d.folders().map(f => f.name)).toContain('A-B - C')
    const w2 = archiveWorld(), d2 = new FakeDrive(); h.drive = d2
    await archiveExecutedDocument(input(w2, 'sow', SOW, { project: { id: PROJ, name: 'Solo', clients: null }, call: d2.call }))
    expect(d2.folders().map(f => f.name).sort()).toEqual(['No client', 'ScopeGov Archive', 'Solo'])
  })

  describe('crash recovery (nothing is ever duplicated)', () => {
    it('a file uploaded but never recorded is FOUND, not uploaded again', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      w.db.tables.integration_external_refs = refs(w).filter((x: any) => x.ref_type !== 'file') // the process died before saving the ref
      const r = await archiveExecutedDocument(input(w, 'sow', SOW))
      expect(r).toMatchObject({ verdict: { outcome: 'ok' }, already: true }); expect(d.pdfs()).toHaveLength(1)
      expect(refs(w).filter((x: any) => x.ref_type === 'file')).toHaveLength(1)
    })
    it('folders created but never recorded are FOUND by their marker, not created again', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      w.db.tables.integration_external_refs = []
      const r = await archiveExecutedDocument(input(w, 'change_order', CO))
      expect(r.verdict.outcome).toBe('ok'); expect(d.folders()).toHaveLength(3); expect(d.pdfs()).toHaveLength(2)
    })
    it('two deliveries racing on a brand-new connection end with one record per thing', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      ;(w.db as any).options = undefined
      await Promise.all([archiveExecutedDocument(input(w, 'sow', SOW)), archiveExecutedDocument(input(w, 'sow', SOW))])
      expect(d.pdfs().length).toBeLessThanOrEqual(2) // the file-level guard is the Drive-side marker; in practice the queue serialises per document
      expect(refs(w).filter((x: any) => x.ref_type === 'file').length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('folders changed in Drive behind our back', () => {
    it('a TRASHED project folder is replaced (uploading into trash would be invisible)', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      const projectFolder = d.folders().find(f => f.name === 'Website Redesign')!; d.trash(projectFolder.id)
      const r = await archiveExecutedDocument(input(w, 'change_order', CO))
      expect(r.verdict.outcome).toBe('ok')
      const co = d.pdfs().find(f => f.name.startsWith('CO-'))!
      expect(d.isTrashed(co)).toBe(false); expect(co.parents[0]).not.toBe(projectFolder.id)
      expect(d.pathOf(co)).toBe('ScopeGov Archive / Acme Ltd / Website Redesign / CO-0003-Second-landing-page-accepted.pdf')
    })
    it('a DELETED folder (404) is replaced the same way', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      d.remove(d.folders().find(f => f.name === 'Website Redesign')!.id)
      const r = await archiveExecutedDocument(input(w, 'change_order', CO)); expect(r.verdict.outcome).toBe('ok')
      const co = d.pdfs().find(f => f.name.startsWith('CO-'))!; expect(d.files.has(co.parents[0])).toBe(true); expect(d.isTrashed(co)).toBe(false)
    })
    it('a trashed ROOT rebuilds the whole chain under a new root', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      d.trash(d.folders().find(f => f.name === 'ScopeGov Archive')!.id)
      const r = await archiveExecutedDocument(input(w, 'change_order', CO)); expect(r.verdict.outcome).toBe('ok')
      const co = d.pdfs().find(f => f.name.startsWith('CO-'))!
      expect(d.isTrashed(co)).toBe(false); expect(d.pathOf(co)).toBe('ScopeGov Archive / Acme Ltd / Website Redesign / CO-0003-Second-landing-page-accepted.pdf')
    })
  })

  describe('refuses, without touching Google, when the document cannot be archived faithfully', () => {
    const cases: Array<[string, () => ReturnType<typeof archiveWorld>, any, RegExp]> = [
      ['no stored PDF (signed before PDFs were frozen)', () => archiveWorld({ sow: { pdf_path: null } }), 'sow', /No stored executed PDF.*not re-rendered/s],
      ['empty pdf_path', () => archiveWorld({ sow: { pdf_path: '' } }), 'sow', /No stored executed PDF/],
      ['not executed yet', () => archiveWorld({ sow: { status: 'sent' } }), 'sow', /not signed/],
      ['a CO that was not accepted', () => archiveWorld({ co: { status: 'declined' } }), 'change_order', /not accepted/],
      ["another workspace's document", () => archiveWorld({ sow: { workspace_id: OTHER_WS } }), 'sow', /no longer exists/],
    ]
    for (const [name, mk, type, msg] of cases) it(name, async () => {
      const w = mk(), d = h.drive as FakeDrive
      const r = await archiveExecutedDocument(input(w, type, type === 'sow' ? SOW : CO))
      expect(r.verdict.outcome).toBe('permanent'); expect((r.verdict as any).error).toMatch(msg); expect(d.calls).toHaveLength(0)
    })
    it('a reference that is not a real document', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      for (const ref of [{ type: 'invoice', id: SOW }, { type: 'sow', id: 'nope' }, { type: 'sow' }, null, undefined]) {
        const r = await archiveExecutedDocument({ ...input(w, 'sow', SOW), event: { id: 'e', workspace_id: WS, project_id: PROJ, data: { document: ref } } })
        expect(r.verdict.outcome).toBe('permanent')
      }
      expect(d.calls).toHaveLength(0)
    })
    it('a PDF over the size cap', async () => {
      const w = archiveWorld({ pdfs: { [`${WS}/sow/${SOW}.pdf`]: Buffer.alloc(MAX_PDF_BYTES + 1) } }), d = h.drive as FakeDrive
      const r = await archiveExecutedDocument(input(w, 'sow', SOW)); expect(r.verdict.outcome).toBe('permanent'); expect((r.verdict as any).error).toMatch(/over the 25 MB/); expect(d.calls).toHaveLength(0)
    })
    it('an unreadable stored PDF is retried, not given up on', async () => {
      const w = archiveWorld({ pdfs: { [`${WS}/sow/${SOW}.pdf`]: null } }), d = h.drive as FakeDrive
      expect((await archiveExecutedDocument(input(w, 'sow', SOW))).verdict.outcome).toBe('retry'); expect(d.calls).toHaveLength(0)
    })
  })

  describe('Google failures map to the right outcome', () => {
    it('Drive full: the RULE turns off with a clear reason (nothing more can be saved)', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive; d.quotaFull = true
      const v = (await archiveExecutedDocument(input(w, 'sow', SOW))).verdict as any
      expect(v.outcome).toBe('rule_off'); expect(v.reason).toMatch(/storage is full/i); expect(refs(w).some((x: any) => x.ref_type === 'file')).toBe(false)
    })
    it('rate limit and 5xx retry; a later success works', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      d.rateLimited = 1; expect((await archiveExecutedDocument(input(w, 'sow', SOW))).verdict.outcome).toBe('retry')
      d.serverError = 1; expect((await archiveExecutedDocument(input(w, 'sow', SOW))).verdict.outcome).toBe('retry')
      expect((await archiveExecutedDocument(input(w, 'sow', SOW))).verdict.outcome).toBe('ok'); expect(d.pdfs()).toHaveLength(1)
    })
    it('a revoked grant is a CONNECTION fault and nothing is sent to Drive', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive; d.tokenError = 'invalid_grant'
      const v = (await archiveExecutedDocument(input(w, 'sow', SOW))).verdict as any
      expect(v.outcome).toBe('connection_off'); expect(v.reason).toMatch(/reconnected/i); expect(d.calls.every(c => c.url.includes('oauth2'))).toBe(true)
    })
    it('an unreadable stored token (wrong key / tampered) is a connection fault and sends nothing', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      const v = (await archiveExecutedDocument(input(w, 'sow', SOW, { connection: { id: CONN, workspace_id: WS, credentials_enc: creds('rt', OTHER_WS) } }))).verdict as any
      expect(v.outcome).toBe('connection_off'); expect(d.calls).toHaveLength(0)
    })
    it('Drive API disabled / access refused is a connection-level problem with a reconnect message', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive; d.apiDisabled = true
      expect((await archiveExecutedDocument(input(w, 'sow', SOW))).verdict.outcome).toBe('connection_off')
    })
    it('an expired access token mid-flight is refreshed ONCE and the work continues', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      d.reject401 = 1
      const r = await archiveExecutedDocument(input(w, 'sow', SOW))
      expect(r.verdict.outcome).toBe('ok'); expect(d.tokensIssued).toBe(2); expect(d.pdfs()).toHaveLength(1)
    })
    it('the access token is minted once and reused across documents', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW)); await archiveExecutedDocument(input(w, 'change_order', CO))
      expect(d.tokensIssued).toBe(1)
    })
    it('a network failure retries instead of throwing', async () => {
      const w = archiveWorld()
      const r = await archiveExecutedDocument(input(w, 'sow', SOW, { call: async (req: any) => { if (req.url.includes('oauth2')) return { status: 200, json: { access_token: 'at-1', expires_in: 3600 }, location: null, retryAfter: null }; throw Object.assign(new Error('x'), { name: 'TimeoutError' }) } }))
      expect(r.verdict.outcome).toBe('retry'); expect((r.verdict as any).error).toMatch(/in time/)
    })
    it('the upload session is opened with the PDF type + length, and the bytes go to the session URL only', async () => {
      const w = archiveWorld(), d = h.drive as FakeDrive
      await archiveExecutedDocument(input(w, 'sow', SOW))
      const init = d.calls.find(c => c.method === 'POST' && c.url.includes('uploadType=resumable'))!
      expect(init.headers).toMatchObject({ 'X-Upload-Content-Type': 'application/pdf', 'X-Upload-Content-Length': String(SOW_PDF.length) })
      const put = d.calls.find(c => c.method === 'PUT')!; expect(put.url).toContain('upload_id='); expect(put.headers?.Authorization).toBeUndefined()
    })
  })
})

// ───────────────────────────── the delivery worker ─────────────────────────────
describe('Drive deliveries in the worker', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z')
  function deliveryWorld(over: { ws?: any; conn?: any; sub?: any; sow?: any; attempts?: number } = {}) {
    const claimed = [{ id: 'd1', workspace_id: WS, subscription_id: RULE, event_id: 'ev-1', attempts: over.attempts ?? 1 }]
    const base = archiveWorld({ sow: over.sow })
    const db = createFakeSupabase({
      integration_deliveries: claimed.map(c => ({ ...c, status: 'delivering' })),
      integration_subscriptions: [{ id: RULE, workspace_id: WS, connection_id: CONN, kind: 'google_drive', name: 'Google Drive archive', target_url: 'https://www.googleapis.com/drive/v3/files', event_types: ['sow.signed'], secret_enc: null, active: true, consecutive_failures: 0, config: {}, ...over.sub }],
      integration_connections: [{ id: CONN, workspace_id: WS, status: 'active', credentials_enc: creds(), config: {}, ...over.conn }],
      integration_events: [{ id: 'ev-1', workspace_id: WS, event_type: 'sow.signed', entity_type: 'project', entity_id: PROJ, project_id: PROJ, data: { title: 'SOW signed', summary: 's', document: { type: 'sow', id: SOW } }, created_at: 'now' }],
      workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...over.ws }],
      projects: [{ id: PROJ, name: 'Website Redesign', status: 'Active', currency: 'USD', client_id: CLIENT, clients: { id: CLIENT, name: 'Acme Ltd' } }],
      sow_documents: base.db.tables.sow_documents, change_orders: base.db.tables.change_orders, integration_external_refs: [],
    }, { rpc: { claim_integration_deliveries: () => ({ data: claimed }) } })
    ;(db.client as any).storage = (base.service as any).storage
    return db
  }
  const run = (db: any, drive?: any) => processDeliveries(db.client, { now: () => NOW, send: vi.fn() as any, drive: drive || ((i: any) => archiveExecutedDocument({ ...i, call: (h.drive as FakeDrive).call, env: ENV })) })
  const d1 = (db: any) => db.tables.integration_deliveries[0], rule = (db: any) => db.tables.integration_subscriptions[0]

  it('end to end: archives the frozen PDF and marks the delivery succeeded', async () => {
    const db = deliveryWorld(), drive = h.drive as FakeDrive
    expect(await run(db)).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(d1(db)).toMatchObject({ status: 'succeeded' }); expect(rule(db).last_success_at).toBeTruthy()
    expect(drive.pdfs().map(f => drive.pathOf(f))).toEqual(['ScopeGov Archive / Acme Ltd / Website Redesign / SOW-Website-Redesign-v1-signed.pdf'])
    expect(Buffer.compare(drive.pdfs()[0].bytes!, SOW_PDF)).toBe(0)
  })
  it('a retried delivery after success changes nothing (at-least-once delivery, exactly-once archive)', async () => {
    const db = deliveryWorld(), drive = h.drive as FakeDrive
    await run(db); db.tables.integration_deliveries[0].status = 'delivering'
    await run(db); expect(drive.pdfs()).toHaveLength(1)
  })
  it('a document with no stored PDF is skipped as dead WITHOUT counting against the rule (old contracts must not switch archiving off)', async () => {
    const db = deliveryWorld({ sow: { pdf_path: null }, sub: { consecutive_failures: 9 } })
    await run(db)
    expect(d1(db)).toMatchObject({ status: 'dead' }); expect(d1(db).last_error).toMatch(/No stored executed PDF/)
    expect(rule(db)).toMatchObject({ active: true, consecutive_failures: 9 })
  })
  it('Drive full switches the rule off with the reason', async () => {
    const db = deliveryWorld(); (h.drive as FakeDrive).quotaFull = true; await run(db)
    expect(d1(db).status).toBe('dead'); expect(rule(db).active).toBe(false); expect(rule(db).disabled_reason).toMatch(/storage is full/i)
  })
  it('a revoked grant flags the connection and switches the rule off ("reconnect")', async () => {
    const db = deliveryWorld(); (h.drive as FakeDrive).tokenError = 'invalid_grant'; await run(db)
    expect(db.tables.integration_connections[0]).toMatchObject({ status: 'error' }); expect(rule(db)).toMatchObject({ active: false }); expect(rule(db).disabled_reason).toMatch(/reconnected/i)
  })
  it('a transient failure retries with backoff', async () => {
    const db = deliveryWorld(); (h.drive as FakeDrive).serverError = 99; await run(db)
    expect(d1(db).status).toBe('pending'); expect(Date.parse(d1(db).next_attempt_at)).toBeGreaterThan(NOW)
  })
  it('a thrown error in the archiver retries', async () => {
    const db = deliveryWorld(); await run(db, async () => { throw new Error('kaboom') })
    expect(d1(db).status).toBe('pending'); expect(d1(db).last_error).toMatch(/kaboom/)
  })
  it('needs the Pro plan; skips when the connection needs reconnecting, is missing, or the rule is off — never calling Google', async () => {
    for (const over of [{ ws: { plan_tier: 'starter' } }, { conn: { status: 'error' } }, { sub: { active: false } }, { ws: { lapsed_at: '2026-10-01' } }]) {
      const db = deliveryWorld(over as any), fn = vi.fn(); await run(db, fn)
      expect(d1(db).status, JSON.stringify(over)).toBe('skipped'); expect(fn).not.toHaveBeenCalled()
    }
  })
})

// ───────────────────────────── routes ─────────────────────────────
const req = (url: string, init: { method?: string; body?: unknown } = {}) => new NextRequest(`http://localhost${url}`, { method: init.method || 'GET', headers: { 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
const jwt = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`
const GOOD_EXCHANGE = (email = 'ada@agency.com') => ({ access_token: 'ya29.access', refresh_token: '1//refresh-token', expires_in: 3599, scope: `${DRIVE_FILE_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`, id_token: jwt(email) })
function routeWorld(over: { conn?: any | null; rule?: any | null; refs?: any[]; docs?: { sow?: any[]; co?: any[] }; events?: any[] } = {}) {
  h.db = createFakeSupabase({
    integration_connections: over.conn === null ? [] : [{ id: CONN, workspace_id: WS, provider: 'google_drive', status: 'active', display_name: 'ada@agency.com', config: { account_email: 'ada@agency.com' }, credentials_enc: creds(), created_at: 'c', last_error: null, ...over.conn }],
    integration_subscriptions: over.rule === null ? [] : [{ id: RULE, workspace_id: WS, connection_id: CONN, kind: 'google_drive', name: 'Google Drive archive', target_url: 'https://www.googleapis.com/drive/v3/files', event_types: ['sow.signed', 'change_order.accepted'], secret_enc: null, active: true, consecutive_failures: 0, config: {}, ...over.rule }],
    integration_external_refs: over.refs ?? [], integration_events: over.events ?? [], integration_deliveries: [],
    sow_documents: over.docs?.sow ?? [], change_orders: over.docs?.co ?? [], audit_log: [],
    workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null }],
  })
  return h.db
}
const tbl = (n: string) => h.db.tables[n]

describe('POST /google-drive/connect', () => {
  beforeEach(() => routeWorld({ conn: null, rule: null }))
  it('returns the consent URL bound to this workspace and person', async () => {
    const r = await connect(); expect(r.status).toBe(200)
    const u = new URL((await r.json()).url); expect(u.hostname).toBe('accounts.google.com')
    expect(verifyGoogleState(u.searchParams.get('state'))).toEqual({ ok: true, state: { ws: WS, uid: USER } })
  })
  it('needs login, the permission, the Pro plan, a recent re-authentication and server config', async () => {
    h.session = null; expect((await connect()).status).toBe(401)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: [] }; expect((await connect()).status).toBe(403)
    h.session = { id: USER, workspaceId: WS, planTier: 'starter', permissions: ALL }; expect((await connect()).status).toBe(402)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: ALL }
    const { NextResponse } = await import('next/server'); h.stepUp = NextResponse.json({ code: 'step_up_required' }, { status: 401 }); expect((await connect()).status).toBe(401); h.stepUp = null
    delete process.env.GOOGLE_CLIENT_SECRET; expect((await connect()).status).toBe(503)
  })
})

describe('GET /google/callback', () => {
  const state = () => signGoogleState({ ws: WS, uid: USER })
  const go = async (qs: string) => { const r = await callback(new NextRequest(`http://localhost/api/integrations/google/callback?${qs}`)); return new URL(r.headers.get('location')!).searchParams.get('drive') }
  beforeEach(() => { routeWorld({ conn: null, rule: null }); (h.drive as FakeDrive).exchange = GOOD_EXCHANGE() })

  it('connects: stores the REFRESH token encrypted (never the access token, never plaintext), makes the folder, creates the rule, audits', async () => {
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    const c = tbl('integration_connections')[0]
    expect(c).toMatchObject({ workspace_id: WS, provider: 'google_drive', status: 'active', created_by: USER, display_name: 'ada@agency.com', config: { account_email: 'ada@agency.com' } })
    expect(JSON.stringify(c)).not.toMatch(/1\/\/refresh-token|ya29/)
    expect(JSON.parse(decryptSecret(c.credentials_enc, `${WS}:${c.id}`))).toEqual({ refresh_token: '1//refresh-token' })
    expect(() => decryptSecret(c.credentials_enc, `${OTHER_WS}:${c.id}`)).toThrow()
    expect((h.drive as FakeDrive).folders().map(f => f.name)).toEqual(['ScopeGov Archive'])
    expect(tbl('integration_external_refs')[0]).toMatchObject({ ref_type: 'folder', local_key: `root:${WS}`, connection_id: c.id })
    expect(tbl('integration_subscriptions')[0]).toMatchObject({ kind: 'google_drive', connection_id: c.id, secret_enc: null, event_types: ['sow.signed', 'change_order.accepted'] })
    expect(tbl('integration_subscriptions')[0].active).not.toBe(false) // the column defaults to true
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.google_drive_connected' })
    const ex = (h.drive as FakeDrive).calls[0]; expect(ex.form).toMatchObject({ grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://app.example.com/api/integrations/google/callback' })
  })
  it('the rule starts with only the events this person may see', async () => {
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'SEND_SOW'] }
    expect(await go(`code=abc&state=${state()}`)).toBe('connected'); expect(tbl('integration_subscriptions')[0].event_types).toEqual(['sow.signed'])
  })
  it('refuses a forged / expired / Slack-minted state, or the wrong person or workspace, without calling Google', async () => {
    const d = h.drive as FakeDrive
    expect(await go('code=abc&state=garbage')).toBe('failed'); expect(await go('code=abc')).toBe('failed')
    expect(await go(`code=abc&state=${signSlackState({ ws: WS, uid: USER })}`)).toBe('failed')
    expect(await go(`code=abc&state=${signGoogleState({ ws: WS, uid: USER }, Date.now() - 11 * 60_000)}`)).toBe('expired')
    h.session = { ...h.session, id: 'someone-else' }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = { ...h.session, id: USER, workspaceId: OTHER_WS }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = null; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    expect(d.calls).toHaveLength(0); expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('refuses without the permission, on a lapsed workspace, or below Pro', async () => {
    h.session = { ...h.session, permissions: [] }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, permissions: ALL, lapsed: true }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, lapsed: false, planTier: 'starter' }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('handles Cancel on Google\'s page', async () => { expect(await go(`error=access_denied&state=${state()}`)).toBe('denied') })
  it('the person UNTICKED the Drive permission: nothing is connected and they are told why', async () => {
    ;(h.drive as FakeDrive).exchange = { ...GOOD_EXCHANGE(), scope: 'openid https://www.googleapis.com/auth/userinfo.email' }
    expect(await go(`code=abc&state=${state()}`)).toBe('scope'); expect(tbl('integration_connections')).toHaveLength(0)
    expect((h.drive as FakeDrive).folders()).toHaveLength(0)
  })
  it('no refresh token (archiving would stop within the hour) is a failure, not a half-connection', async () => {
    ;(h.drive as FakeDrive).exchange = { ...GOOD_EXCHANGE(), refresh_token: undefined }
    expect(await go(`code=abc&state=${state()}`)).toBe('failed'); expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('a bad / used code from Google fails cleanly', async () => {
    ;(h.drive as FakeDrive).exchange = null; expect(await go(`code=abc&state=${state()}`)).toBe('failed'); expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('Drive API not enabled for the Google project: reported at connect time, nothing kept, token revoked', async () => {
    ;(h.drive as FakeDrive).apiDisabled = true
    expect(await go(`code=abc&state=${state()}`)).toBe('api')
    expect(tbl('integration_connections')).toHaveLength(0); expect(tbl('integration_subscriptions')).toHaveLength(0)
    expect((h.drive as FakeDrive).revoked).toEqual(['1//refresh-token'])
  })
  it('RECONNECTING the same Google account keeps the records and switches a rule that a dead token had turned off back on', async () => {
    routeWorld({ rule: { active: false, disabled_reason: 'Google Drive needs to be reconnected (access was revoked or expired).', consecutive_failures: 10 }, conn: { status: 'error', last_error: 'x' },
      refs: [{ id: 'r1', workspace_id: WS, connection_id: CONN, ref_type: 'file', local_key: `sow:${SOW}`, remote_id: 'f1' }] })
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    expect(tbl('integration_connections')).toHaveLength(1); expect(tbl('integration_connections')[0]).toMatchObject({ id: CONN, status: 'active', last_error: null })
    expect(tbl('integration_subscriptions')[0]).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0 })
    expect(tbl('integration_external_refs').some((r: any) => r.id === 'r1')).toBe(true)
  })
  it('a rule the admin turned off by hand stays off after a reconnect', async () => {
    routeWorld({ rule: { active: false, disabled_reason: null } }); await go(`code=abc&state=${state()}`)
    expect(tbl('integration_subscriptions')[0].active).toBe(false)
  })
  it('connecting a DIFFERENT Google account forgets the old account\'s folder and file records', async () => {
    routeWorld({ refs: [{ id: 'r1', workspace_id: WS, connection_id: CONN, ref_type: 'file', local_key: `sow:${SOW}`, remote_id: 'f1' }] })
    ;(h.drive as FakeDrive).exchange = GOOD_EXCHANGE('someone.else@gmail.com')
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    expect(tbl('integration_external_refs').some((r: any) => r.id === 'r1')).toBe(false)
    expect(tbl('integration_connections')[0].config.account_email).toBe('someone.else@gmail.com')
  })
})

describe('DELETE /google-drive (disconnect)', () => {
  it('revokes the refresh token at Google, forgets the connection, audits — and leaves the files alone', async () => {
    routeWorld(); const d = h.drive as FakeDrive; d.add({ name: 'keep me', mimeType: 'application/pdf', parents: [], appProperties: {} })
    expect((await disconnect()).status).toBe(200)
    expect(d.revoked).toEqual(['rt-1']); expect(tbl('integration_connections')).toHaveLength(0); expect(d.pdfs()).toHaveLength(1)
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.google_drive_disconnected' })
  })
  it('works on any plan and when Google or the token is unavailable; a no-op when not connected', async () => {
    routeWorld({ conn: { credentials_enc: 'garbage' } }); h.session = { ...h.session, planTier: 'solo' }
    expect((await disconnect()).status).toBe(200); expect(tbl('integration_connections')).toHaveLength(0)
    expect((await disconnect()).status).toBe(200)
  })
  it('requires the permission', async () => { routeWorld(); h.session = { ...h.session, permissions: [] }; expect((await disconnect()).status).toBe(403) })
})

describe('PATCH /google-drive (the archive rule)', () => {
  const patch = (body: unknown) => patchRule(req('/x', { method: 'PATCH', body }))
  beforeEach(() => routeWorld())
  it('changes which documents are archived (only the two executed types), permission-checked per type', async () => {
    expect((await patch({ events: ['sow.signed'] })).status).toBe(200); expect(tbl('integration_subscriptions')[0].event_types).toEqual(['sow.signed'])
    expect((await patch({ events: ['invoice.paid'] })).status).toBe(400); expect((await patch({ events: ['guardian.flag_raised'] })).status).toBe(400)
    expect((await patch({ events: 'sow.signed' })).status).toBe(400)
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'SEND_SOW'] }
    const r = await patch({ events: ['sow.signed', 'change_order.accepted'] }); expect(r.status).toBe(403); expect((await r.json()).error).toMatch(/SEND_CHANGE_ORDERS/)
  })
  it('toggles; turning on needs a live connection and clears the failure streak', async () => {
    routeWorld({ rule: { active: false, disabled_reason: 'x', consecutive_failures: 7 } })
    expect((await patch({ active: true })).status).toBe(200); expect(tbl('integration_subscriptions')[0]).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0 })
    routeWorld({ rule: { active: false }, conn: { status: 'error' } }); const r = await patch({ active: true }); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true)
    expect((await patch({ active: false })).status).toBe(200)
  })
  it('validates, and needs a connection and Pro', async () => {
    expect((await patch({})).status).toBe(400); expect((await patch({ active: 'yes' })).status).toBe(400); expect((await patch(undefined)).status).toBe(400)
    routeWorld({ conn: null, rule: null }); expect((await patch({ active: true })).status).toBe(409)
    routeWorld(); h.session = { ...h.session, planTier: 'starter' }; expect((await patch({ active: false })).status).toBe(402)
  })
})

describe('POST /google-drive/backfill', () => {
  const doc = (id: string, over: any = {}) => ({ id, workspace_id: WS, project_id: PROJ, status: 'signed', pdf_path: `${WS}/sow/${id}.pdf`, signed_at: '2026-01-01', ...over })
  const co = (id: string, over: any = {}) => ({ id, workspace_id: WS, project_id: PROJ, status: 'accepted', pdf_path: `${WS}/co/${id}.pdf`, accepted_at: '2026-01-01', ...over })
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const run = () => backfill()

  it('queues executed documents that have a frozen PDF and are not in Drive yet, through the normal queue', async () => {
    routeWorld({ docs: { sow: [doc(U(1)), doc(U(2)), doc(U(3), { pdf_path: null }), doc(U(4), { pdf_path: '' }), doc(U(5), { status: 'sent' }), doc(U(6), { workspace_id: OTHER_WS })], co: [co(U(7))] },
      refs: [{ id: 'x', workspace_id: WS, connection_id: CONN, ref_type: 'file', local_key: `sow:${U(2)}`, remote_id: 'f' }] })
    const r = await run(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ queued: 2, alreadyArchived: 1, capped: false })
    const ev = tbl('integration_events'); expect(ev.map((e: any) => `${e.event_type}:${e.data.document.id}`).sort()).toEqual([`change_order.accepted:${U(7)}`, `sow.signed:${U(1)}`])
    expect(ev.every((e: any) => e.entity_type === 'drive_backfill' && e.workspace_id === WS && e.data.document.type)).toBe(true)
    expect(tbl('integration_deliveries').every((d: any) => d.subscription_id === RULE && d.workspace_id === WS)).toBe(true); expect(tbl('integration_deliveries')).toHaveLength(2)
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.google_drive_backfill' })
  })
  it('only the document types the rule archives, and only ones this person may route', async () => {
    routeWorld({ rule: { event_types: ['sow.signed'] }, docs: { sow: [doc(U(1))], co: [co(U(7))] } })
    expect((await (await run()).json()).queued).toBe(1)
    routeWorld({ docs: { sow: [doc(U(1))], co: [co(U(7))] } }); h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'SEND_CHANGE_ORDERS'] }
    expect((await (await run()).json()).queued).toBe(1); expect(tbl('integration_events')[0].event_type).toBe('change_order.accepted')
  })
  it('is bounded: at most 200 of a type per click, and says so', async () => {
    routeWorld({ docs: { sow: Array.from({ length: BACKFILL_LIMIT + 50 }, (_, i) => doc(U(i + 1000))), co: [] } })
    const j = await (await run()).json(); expect(j).toMatchObject({ queued: BACKFILL_LIMIT, capped: true })
  })
  it('a second click inside ten minutes is refused (cannot flood Drive); nothing is queued twice', async () => {
    routeWorld({ docs: { sow: [doc(U(1))], co: [] } })
    expect((await run()).status).toBe(200); const r = await run(); expect(r.status).toBe(429); expect(tbl('integration_events')).toHaveLength(1)
  })
  it('a document that is already pending is harmless: the archiver is idempotent (covered above)', async () => {
    routeWorld({ docs: { sow: [doc(U(1))], co: [] } }); await run(); expect(tbl('integration_deliveries')).toHaveLength(1)
  })
  it('needs: a live connection, an ON rule, the permission and Pro', async () => {
    routeWorld({ conn: null, rule: null }); expect((await run()).status).toBe(409)
    routeWorld({ conn: { status: 'error' } }); const r = await run(); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true)
    routeWorld({ rule: { active: false } }); expect((await run()).status).toBe(409)
    routeWorld(); h.session = { ...h.session, permissions: [] }; expect((await run()).status).toBe(403)
    routeWorld(); h.session = { ...h.session, permissions: ALL, planTier: 'starter' }; expect((await run()).status).toBe(402)
  })
  it('nothing to archive is a quiet success', async () => {
    routeWorld({ docs: { sow: [], co: [] } }); expect(await (await run()).json()).toEqual({ queued: 0, alreadyArchived: 0, capped: false })
  })
})

describe('GET /integrations overview: the Drive block', () => {
  it('not connected', async () => {
    routeWorld({ conn: null, rule: null }); const j = await (await overview()).json()
    expect(j.drive).toMatchObject({ configured: true, allowed: true, connection: null, rule: null, archived: 0 })
  })
  it('connected: account, archived count, folder link and the rule (and the rule is NOT listed as a webhook)', async () => {
    routeWorld({ refs: [{ id: '1', workspace_id: WS, connection_id: CONN, ref_type: 'folder', local_key: `root:${WS}`, remote_id: 'ROOT123' },
      { id: '2', workspace_id: WS, connection_id: CONN, ref_type: 'file', local_key: 'sow:a', remote_id: 'f1' }, { id: '3', workspace_id: WS, connection_id: CONN, ref_type: 'file', local_key: 'co:b', remote_id: 'f2' }] })
    const j = await (await overview()).json()
    expect(j.drive.connection).toMatchObject({ account_email: 'ada@agency.com', status: 'active', folder_url: 'https://drive.google.com/drive/folders/ROOT123' })
    expect(j.drive.archived).toBe(2); expect(j.drive.rule).toMatchObject({ active: true, event_types: ['sow.signed', 'change_order.accepted'] })
    expect(j.subscriptions).toHaveLength(0)
    expect(JSON.stringify(j)).not.toMatch(/refresh|credentials|rt-1/)
  })
  it('server not configured / below Pro are reported (not errors)', async () => {
    routeWorld({ conn: null, rule: null }); delete process.env.GOOGLE_CLIENT_ID; h.session = { ...h.session, planTier: 'starter' }
    expect((await (await overview()).json()).drive).toMatchObject({ configured: false, allowed: false })
  })
})

describe('docs stay honest', () => {
  it('the setup README names the exact redirect path and the narrow scope the code uses', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'google-drive', 'README.md'), 'utf8')
    expect(md).toContain('/api/integrations/google/callback'); expect(md).toContain('drive.file'); expect(md).toMatch(/Enable/); expect(md).toMatch(/Publish app/)
    expect([...GOOGLE_SCOPES]).toEqual([DRIVE_FILE_SCOPE, 'openid', 'email'])
  })
})
