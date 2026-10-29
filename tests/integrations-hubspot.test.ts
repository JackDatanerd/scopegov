import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { createFakeSupabase } from './helpers/fake-supabase'
import { FakeHubspot, PIPELINE } from './helpers/fake-hubspot'

const h = vi.hoisted(() => ({ db: null as any, session: null as any, stepUp: null as any, hs: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: (s: any, p: string) => !!s?.permissions?.includes(p) }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => h.stepUp }))
vi.mock('@/lib/integrations/hubspot', async (orig) => ({ ...(await orig<any>()), hubspotCall: (r: any) => h.hs.call(r) }))

import { hubspotAuthorizeUrl, hubspotConfigured, hubspotRedirectUri, hubspotRecordUrl, signHubspotState, verifyHubspotState, HUBSPOT_SCOPES, HUBSPOT_EVENT_PERMISSIONS, HUBSPOT_BACKFILL_LIMIT } from '@/lib/integrations/hubspot-config'
import { classifyHubspot, classifyHubspotToken, hubspotAccessToken, clearHubspotTokenCache, isAllowedHubspotUrl, stagesOf } from '@/lib/integrations/hubspot'
import { syncEventToHubspot, splitName, esc } from '@/lib/integrations/hubspot-sync'
import { signState as signSlackState } from '@/lib/integrations/slack-config'
import { signGoogleState } from '@/lib/integrations/google-config'
import { encryptSecret, decryptSecret } from '@/lib/integrations/crypto'
import { permissionForEvent } from '@/lib/integrations/events'
import { processDeliveries } from '@/lib/integrations/delivery'
import { POST as connect } from '@/app/api/workspace/integrations/hubspot/connect/route'
import { GET as callback } from '@/app/api/integrations/hubspot/callback/route'
import { DELETE as disconnect, PATCH as patchRule } from '@/app/api/workspace/integrations/hubspot/route'
import { GET as listPipelines } from '@/app/api/workspace/integrations/hubspot/pipelines/route'
import { POST as backfill } from '@/app/api/workspace/integrations/hubspot/backfill/route'
import { GET as overview } from '@/app/api/workspace/integrations/route'

const KEY = randomBytes(32).toString('base64')
const WS = '0f1e2d3c-4b5a-4968-8776-655443322110', OTHER_WS = '11111111-2222-4333-8444-555555555555', USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONN = '55555555-5555-4555-8555-555555555555', RULE = '66666666-6666-4666-8666-666666666666'
const PROJ = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', CLIENT = '9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f', SOW = '3c1f0a52-7d84-4b6e-9a21-5e0d8c7b4a10'
const ENV = { INTEGRATIONS_ENCRYPTION_KEY: KEY, HUBSPOT_CLIENT_ID: 'hs-cid', HUBSPOT_CLIENT_SECRET: 'hs-secret', NEXT_PUBLIC_APP_URL: 'https://app.example.com' } as unknown as NodeJS.ProcessEnv
const ALL = ['SEND_SOW', 'SEND_CHANGE_ORDERS', 'APPROVE_FLAGS', 'VIEW_FINANCIALS', 'VIEW_CLIENT_DATA', 'MANAGE_WORKSPACE_SETTINGS']
const creds = (rt = 'rt-hs', ws = WS, conn = CONN) => encryptSecret(JSON.stringify({ refresh_token: rt }), `${ws}:${conn}`)

beforeEach(() => {
  Object.assign(process.env, ENV)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  clearHubspotTokenCache()
  h.hs = new FakeHubspot()
  h.session = { id: USER, name: 'Ada', email: 'ada@acme.com', workspaceId: WS, planTier: 'pro', lapsed: false, permissions: ALL }
  h.stepUp = null
})

// ───────────────────────────── config, state, URL allow-list, classification ─────────────────────────────
describe('HubSpot config & state', () => {
  it('asks for exactly the contacts / companies / deals scopes (no schema, no owners, no custom properties)', () => {
    const u = new URL(hubspotAuthorizeUrl('STATE', ENV)!)
    expect(u.origin + u.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(u.searchParams.get('client_id')).toBe('hs-cid'); expect(u.searchParams.get('state')).toBe('STATE')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/integrations/hubspot/callback')
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual([...HUBSPOT_SCOPES].sort())
    expect(u.searchParams.get('scope')).not.toMatch(/schemas|owners|timeline|automation|forms|files/)
    expect(hubspotAuthorizeUrl('s', { ...ENV, NEXT_PUBLIC_APP_URL: '' } as any)).toBeNull()
    expect(hubspotConfigured({} as any)).toBe(false); expect(hubspotRedirectUri({ NEXT_PUBLIC_APP_URL: 'https://x.co/' } as any)).toBe('https://x.co/api/integrations/hubspot/callback')
  })
  it('state round-trips; Slack- and Google-minted states are rejected here', () => {
    const t = signHubspotState({ ws: WS, uid: USER }, 1_800_000_000_000, ENV)
    expect(verifyHubspotState(t, 1_800_000_001_000, ENV)).toEqual({ ok: true, state: { ws: WS, uid: USER } })
    expect(verifyHubspotState(signSlackState({ ws: WS, uid: USER }, 1_800_000_000_000, ENV), 1_800_000_001_000, ENV).ok).toBe(false)
    expect(verifyHubspotState(signGoogleState({ ws: WS, uid: USER }, 1_800_000_000_000, ENV), 1_800_000_001_000, ENV).ok).toBe(false)
    expect(verifyHubspotState(t, 1_800_000_000_000 + 11 * 60_000, ENV)).toEqual({ ok: false, reason: 'expired' })
  })
  it('record links open the right HubSpot object type', () => {
    expect(hubspotRecordUrl(4242, 'deal', '99')).toBe('https://app.hubspot.com/contacts/4242/record/0-3/99')
    expect(hubspotRecordUrl(4242, 'company', '7')).toContain('/record/0-2/'); expect(hubspotRecordUrl(4242, 'contact', '7')).toContain('/record/0-1/')
  })
  it('the events HubSpot acts on use the SAME permission as every other integration for that event (no drift)', () => {
    for (const [ev, perm] of Object.entries(HUBSPOT_EVENT_PERMISSIONS)) expect(permissionForEvent(ev), ev).toBe(perm)
  })
})

describe('HubSpot URL allow-list', () => {
  it('only https://api.hubapi.com /crm/ and /oauth/', () => {
    for (const ok of ['https://api.hubapi.com/crm/v3/objects/deals', 'https://api.hubapi.com/oauth/v1/token', 'https://api.hubapi.com/crm/v4/objects/deals/1/associations/default/companies/2']) expect(isAllowedHubspotUrl(ok), ok).toBe(true)
    for (const bad of ['http://api.hubapi.com/crm/v3/objects', 'https://evil.example.com/crm/v3/objects', 'https://api.hubapi.com.evil.com/crm/v3/x', 'https://api.hubapi.com/files/v3/files',
      'https://api.hubapi.com:8443/crm/v3/x', 'https://u:p@api.hubapi.com/crm/v3/x', 'https://app.hubspot.com/oauth/authorize', 'not a url', ''])
      expect(isAllowedHubspotUrl(bad), bad).toBe(false)
  })
  it('the REAL caller refuses an off-list URL before sending anything', async () => {
    const real = await vi.importActual<any>('@/lib/integrations/hubspot'); const spy = vi.spyOn(globalThis, 'fetch')
    await expect(real.hubspotCall({ method: 'POST', url: 'https://evil.example.com/steal', json: { a: 1 } })).rejects.toThrow(/non-HubSpot/)
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore()
  })
})

describe('classifying HubSpot answers', () => {
  const c = (status: number, json: any = null) => classifyHubspot({ status, json })
  it('2xx ok; 429 / RATE_LIMITS / 5xx / 409 retry', () => {
    expect(c(200).outcome).toBe('ok'); expect(c(201).outcome).toBe('ok')
    expect(c(429).outcome).toBe('retry'); expect(c(400, { category: 'RATE_LIMITS' }).outcome).toBe('retry'); expect(c(503).outcome).toBe('retry'); expect(c(409, { message: 'dup' }).outcome).toBe('retry')
  })
  it('401 / 403 (incl. MISSING_SCOPES) are connection faults with a reconnect message', () => {
    for (const s of [401, 403]) { const v = c(s, { category: 'MISSING_SCOPES' }) as any; expect(v.outcome).toBe(s === 401 || s === 403 ? 'connection_off' : ''); expect(v.reason).toMatch(/reconnect/i) }
  })
  it('404 is not_found; a bad pipeline/stage turns the RULE off; other 400s are permanent', () => {
    expect(c(404).outcome).toBe('not_found')
    const v = c(400, { category: 'VALIDATION_ERROR', message: 'closedwon is not a valid dealstage for pipeline x' }) as any; expect(v.outcome).toBe('rule_off'); expect(v.reason).toMatch(/pipeline/i)
    expect(c(400, { category: 'VALIDATION_ERROR', message: 'Property "foo" does not exist' }).outcome).toBe('permanent')
  })
  it('token endpoint: a revoked / expired refresh token is a connection fault', () => {
    expect(classifyHubspotToken({ status: 400, json: { status: 'BAD_REFRESH_TOKEN' } }).outcome).toBe('connection_off')
    expect(classifyHubspotToken({ status: 400, json: { status: 'BAD_CLIENT' } }).outcome).toBe('connection_off')
    expect(classifyHubspotToken({ status: 503, json: null }).outcome).toBe('retry')
    expect(classifyHubspotToken({ status: 400, json: { status: 'SOMETHING_ELSE' } }).outcome).toBe('permanent')
  })
  it('finds open / won / lost stages from HubSpot\'s own metadata, whatever the stage ids are called', () => {
    const s = stagesOf({ id: 'p1', label: 'Custom', stages: [
      { id: 'zzz-lost', displayOrder: 5, metadata: { isClosed: 'true', probability: '0.0' } }, { id: 'aaa-first', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.1' } },
      { id: 'mid', displayOrder: 2, metadata: { isClosed: 'false', probability: '0.5' } }, { id: 'yyy-won', displayOrder: 4, metadata: { isClosed: 'true', probability: '1.0' } }] })
    expect(s).toEqual({ id: 'p1', label: 'Custom', open: 'aaa-first', won: 'yyy-won', lost: 'zzz-lost' })
    expect(stagesOf({ id: 'x', stages: [{ id: 'only', metadata: { isClosed: 'false', probability: '0.3' } }] })).toMatchObject({ won: null, lost: null, open: 'only' })
    expect(stagesOf(null)).toMatchObject({ won: null, lost: null, open: null })
  })
})

describe('access tokens', () => {
  it('mints one, caches it per connection, refreshes after expiry, sends client credentials in the form', async () => {
    const hs = h.hs as FakeHubspot
    expect(await hubspotAccessToken('c1', 'rt', hs.call, ENV, 1_000)).toEqual({ ok: true, token: 'hs-at-1' })
    expect(await hubspotAccessToken('c1', 'rt', hs.call, ENV, 2_000)).toEqual({ ok: true, token: 'hs-at-1' }); expect(hs.tokensIssued).toBe(1)
    expect(await hubspotAccessToken('c1', 'rt', hs.call, ENV, 1_000 + 1_800_000)).toEqual({ ok: true, token: 'hs-at-2' })
    expect(hs.calls[0].form).toEqual({ grant_type: 'refresh_token', client_id: 'hs-cid', client_secret: 'hs-secret', refresh_token: 'rt' })
  })
  it('a revoked grant is a connection fault and is not cached', async () => {
    const hs = h.hs as FakeHubspot; hs.tokenError = 'BAD_REFRESH_TOKEN'
    const r = await hubspotAccessToken('c1', 'rt', hs.call, ENV, 1_000); expect(r.ok).toBe(false); expect((r as any).verdict.outcome).toBe('connection_off')
  })
})

describe('names and escaping', () => {
  it('splits a person name; escapes HTML', () => {
    expect(splitName('Jane Doe')).toEqual({ firstname: 'Jane', lastname: 'Doe' }); expect(splitName('Mary Ann van Dyke')).toEqual({ firstname: 'Mary Ann van', lastname: 'Dyke' })
    expect(splitName('Cher')).toEqual({ firstname: 'Cher' }); expect(splitName('  ')).toEqual({ firstname: '' })
    expect(esc('<b>"Tom" & <script>')).toBe('&lt;b&gt;"Tom" &amp; &lt;script&gt;')
  })
})

// ───────────────────────────── the sync engine ─────────────────────────────
const CLIENT_ROW = { id: CLIENT, name: 'Jane Doe', company_name: 'Acme Ltd', email: 'Jane@Acme.com', phone: '+1 555 0100' }
function world(over: { project?: any; client?: any | null } = {}) {
  const db = createFakeSupabase({
    projects: [{ id: PROJ, workspace_id: WS, name: 'Website Redesign', status: 'Active', contract_value: 12500, currency: 'USD', client_id: CLIENT, deleted_at: null, clients: over.client === null ? null : { ...CLIENT_ROW, ...over.client }, ...over.project }],
    integration_external_refs: [],
  })
  return { db, service: db.client as any }
}
let evSeq = 0
const evt = (type = 'sow.signed', data: any = {}, over: any = {}) => ({
  id: over.id ?? `ev-${++evSeq}`, event_type: type, workspace_id: WS, project_id: PROJ, created_at: '2026-01-15T09:30:00.000Z',
  data: { title: `${type} — Website Redesign`, summary: 'Acme did something.', document: { type: 'sow', id: SOW }, ...data }, ...over,
})
const run = (w: ReturnType<typeof world>, event: any, over: any = {}) => syncEventToHubspot({
  service: w.service, connection: { id: CONN, workspace_id: WS, credentials_enc: creds() }, rule: { config: { pipeline_id: 'default', include_amounts: false } },
  event, call: (h.hs as FakeHubspot).call, env: ENV, nowMs: (h.hs as FakeHubspot).clock, ...over,
})
const refs = (w: any) => w.db.tables.integration_external_refs
const refKeys = (w: any) => refs(w).map((r: any) => r.local_key).sort()

describe('syncing a signed SOW', () => {
  it('creates the company, the contact, a Closed-won deal linked to both, and a timeline note', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    const r = await run(w, evt('sow.signed', { signed_by: 'Jane Doe' })); expect(r.verdict.outcome).toBe('ok')
    expect(hs.list('companies').map(c => c.properties)).toEqual([{ name: 'Acme Ltd' }])
    expect(hs.list('contacts').map(c => c.properties)).toEqual([{ email: 'jane@acme.com', firstname: 'Jane', lastname: 'Doe', phone: '+1 555 0100' }])
    const [deal] = hs.list('deals'); expect(hs.list('deals')).toHaveLength(1)
    expect(deal.properties).toMatchObject({ dealname: 'Website Redesign', pipeline: 'default', dealstage: 'closedwon', closedate: '2026-01-15T09:30:00.000Z' })
    expect(deal.properties.description).toBe('ScopeGov project for Jane Doe. Status: Active.')
    expect(deal.properties.amount).toBeUndefined() // amounts are opt-in
    const [company] = hs.list('companies'), [contact] = hs.list('contacts'), [note] = hs.list('notes')
    expect(hs.linked('deals', deal.id, 'companies', company.id)).toBe(true); expect(hs.linked('deals', deal.id, 'contacts', contact.id)).toBe(true)
    expect(hs.linked('contacts', contact.id, 'companies', company.id)).toBe(true); expect(hs.linked('notes', note.id, 'deals', deal.id)).toBe(true)
    expect(note.properties.hs_note_body).toContain('<strong>sow.signed — Website Redesign</strong>'); expect(note.properties.hs_note_body).toContain('Signed by: Jane Doe'); expect(note.properties.hs_note_body).toContain('via ScopeGov')
    expect(refKeys(w).filter((k: string) => !k.startsWith('note:'))).toEqual([`company:${CLIENT}`, `contact:${CLIENT}`, `deal:${PROJ}`])
    expect(refKeys(w).filter((k: string) => k.startsWith('note:'))).toHaveLength(1)
    expect(r.dealId).toBe(deal.id)
  })
  it('sends the contract value as the deal amount ONLY when the rule says so', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed'), { rule: { config: { pipeline_id: 'default', include_amounts: true } } })
    expect(hs.list('deals')[0].properties.amount).toBe('12500')
    expect(JSON.stringify(hs.list('deals')[0].properties.description)).not.toMatch(/12500|\$/)
  })
  it('a declined SOW creates a Closed-LOST deal; a later signature moves the SAME deal to Closed-won', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.declined', { reason: 'Too expensive.' })); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('deals')[0].properties.dealstage).toBe('closedlost')
    await run(w, evt('sow.signed')); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('deals')[0].properties.dealstage).toBe('closedwon')
  })
  it('uses the pipeline the rule names, with that pipeline\'s own stage ids', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    hs.pipelines = [PIPELINE, { id: 'p2', label: 'Retainers', stages: [{ id: 'new', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.1' } }, { id: 'won-2', displayOrder: 1, metadata: { isClosed: 'true', probability: '1.0' } }, { id: 'lost-2', displayOrder: 2, metadata: { isClosed: 'true', probability: '0.0' } }] }]
    await run(w, evt('sow.signed'), { rule: { config: { pipeline_id: 'p2' } } })
    expect(hs.list('deals')[0].properties).toMatchObject({ pipeline: 'p2', dealstage: 'won-2' })
  })
})

describe('later events on the same project', () => {
  it('add a note only: no second company, contact or deal, and the deal is not touched', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed')); const before = hs.calls.length
    await run(w, evt('guardian.flag_raised', { summary: 'A request outside scope.' }))
    expect(hs.list('companies')).toHaveLength(1); expect(hs.list('contacts')).toHaveLength(1); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('notes')).toHaveLength(2)
    expect(hs.calls.slice(before).some(c => c.method === 'PATCH')).toBe(false)
  })
  it('the same event twice adds ONE note (retries are harmless)', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    const e = evt('invoice.paid', {}, { id: 'ev-same' }); await run(w, e); await run(w, e)
    expect(hs.list('notes')).toHaveLength(1); expect(hs.list('deals')).toHaveLength(1)
  })
  it('an accepted change order refreshes the deal amount to the CURRENT contract value (only if amounts are on)', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed'), { rule: { config: { pipeline_id: 'default', include_amounts: true } } }); expect(hs.list('deals')[0].properties.amount).toBe('12500')
    w.db.tables.projects[0].contract_value = 15000
    await run(w, evt('change_order.accepted'), { rule: { config: { pipeline_id: 'default', include_amounts: true } } }); expect(hs.list('deals')[0].properties.amount).toBe('15000')
    w.db.tables.projects[0].contract_value = 99999
    await run(w, evt('change_order.accepted'), { rule: { config: { pipeline_id: 'default', include_amounts: false } } }); expect(hs.list('deals')[0].properties.amount).toBe('15000')
  })
  it('an event on a project with no deal yet creates the deal (won), so a late-connected workspace still works', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('invoice.paid')); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('deals')[0].properties.dealstage).toBe('closedwon')
  })
  it('a backfilled event adds no timeline noise', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed', { backfill: true })); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('notes')).toHaveLength(0)
  })
})

describe('your existing HubSpot data is never overwritten', () => {
  it('an existing company (same name) and contact (same email) are LINKED to and left exactly as they were', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    const co = hs.add('companies', { name: 'Acme Ltd', phone: '111', industry: 'Retail' }), ct = hs.add('contacts', { email: 'jane@acme.com', firstname: 'Janet', jobtitle: 'CEO' })
    await run(w, evt('sow.signed'))
    expect(hs.list('companies')).toHaveLength(1); expect(hs.list('contacts')).toHaveLength(1)
    expect(co.properties).toEqual({ name: 'Acme Ltd', phone: '111', industry: 'Retail' }); expect(ct.properties).toEqual({ email: 'jane@acme.com', firstname: 'Janet', jobtitle: 'CEO' })
    expect(hs.customerDataWrites()).toHaveLength(0)
    expect(hs.calls.filter(c => c.method === 'POST' && /objects\/(companies|contacts)$/.test(c.url))).toHaveLength(0) // not even a create
    const [deal] = hs.list('deals'); expect(hs.linked('deals', deal.id, 'companies', co.id)).toBe(true); expect(hs.linked('deals', deal.id, 'contacts', ct.id)).toBe(true)
    expect(refs(w).find((r: any) => r.ref_type === 'company').remote_id).toBe(co.id)
  })
  it('with several same-named companies, the OLDEST is linked', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    hs.add('companies', { name: 'Acme Ltd' }, 'newer', 2_000); const oldest = hs.add('companies', { name: 'Acme Ltd' }, 'older', 1_000)
    await run(w, evt('sow.signed')); expect(refs(w).find((r: any) => r.ref_type === 'company').remote_id).toBe(oldest.id)
  })
  it('a contact created by someone else between our search and our create (409) is linked, not duplicated', async () => {
    const w = world(), hs = h.hs as FakeHubspot; hs.racingContact = { email: 'jane@acme.com', id: 'racer-1' }
    const r = await run(w, evt('sow.signed')); expect(r.verdict.outcome).toBe('ok')
    expect(hs.list('contacts')).toHaveLength(1); expect(refs(w).find((x: any) => x.ref_type === 'contact').remote_id).toBe('racer-1')
  })
  it('only deals ScopeGov created are ever edited (nothing else is PATCHed)', async () => {
    const w = world(), hs = h.hs as FakeHubspot; const foreign = hs.add('deals', { dealname: 'Someone else\'s deal', dealstage: 'contractsent' }, 'foreign', 5)
    await run(w, evt('sow.signed')); await run(w, evt('sow.declined')); await run(w, evt('change_order.accepted'))
    expect(foreign.properties).toEqual({ dealname: 'Someone else\'s deal', dealstage: 'contractsent' })
    expect(hs.calls.filter(c => c.method === 'PATCH').every(c => c.url.endsWith(`/deals/${refs(w).find((r: any) => r.ref_type === 'deal').remote_id}`))).toBe(true)
  })
})

describe('what is created depends on what the client has', () => {
  it('no company name -> no company; no email -> no contact; neither -> a plain deal', async () => {
    let w = world({ client: { company_name: null } }), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed')); expect(hs.list('companies')).toHaveLength(0); expect(hs.list('contacts')).toHaveLength(1)
    h.hs = new FakeHubspot(); hs = h.hs; clearHubspotTokenCache(); w = world({ client: { email: null } })
    await run(w, evt('sow.signed')); expect(hs.list('companies')).toHaveLength(1); expect(hs.list('contacts')).toHaveLength(0)
    h.hs = new FakeHubspot(); hs = h.hs; clearHubspotTokenCache(); w = world({ client: { email: null, company_name: '  ' } })
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok'); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('companies')).toHaveLength(0)
    h.hs = new FakeHubspot(); hs = h.hs; clearHubspotTokenCache(); w = world({ client: null })
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok'); expect(hs.list('deals')[0].properties.description).toBe('ScopeGov project. Status: Active.')
  })
})

describe('crash recovery and self-healing', () => {
  it('a deal made just before a crash (never recorded) is ADOPTED, not duplicated; an old same-named deal is not', async () => {
    let w = world(), hs = h.hs as FakeHubspot
    const orphan = hs.add('deals', { dealname: 'Website Redesign', dealstage: 'appointmentscheduled', pipeline: 'default' }, 'orphan', hs.clock - 5 * 60_000)
    await run(w, evt('sow.signed'))
    expect(hs.list('deals')).toHaveLength(1); expect(refs(w).find((r: any) => r.ref_type === 'deal').remote_id).toBe(orphan.id); expect(orphan.properties.dealstage).toBe('closedwon')
    h.hs = new FakeHubspot(); hs = h.hs; clearHubspotTokenCache(); w = world()
    const old = hs.add('deals', { dealname: 'Website Redesign', dealstage: 'contractsent' }, 'old', hs.clock - 3 * 3_600_000)
    await run(w, evt('sow.signed')); expect(hs.list('deals')).toHaveLength(2); expect(old.properties.dealstage).toBe('contractsent')
  })
  it('a deal DELETED in HubSpot is recreated on the next event and the record updated', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed')); const first = hs.list('deals')[0].id; hs.remove('deals', first)
    const r = await run(w, evt('sow.signed')); expect(r.verdict.outcome).toBe('ok')
    expect(hs.list('deals')).toHaveLength(1); expect(hs.list('deals')[0].id).not.toBe(first)
    expect(refs(w).find((x: any) => x.ref_type === 'deal').remote_id).toBe(hs.list('deals')[0].id)
  })
  it('a deleted company is rebuilt AND the surviving/recreated deal is linked to the new one', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed')); const oldCo = hs.list('companies')[0].id, oldDeal = hs.list('deals')[0].id
    hs.remove('companies', oldCo); hs.remove('deals', oldDeal)
    const r = await run(w, evt('sow.signed')); expect(r.verdict.outcome).toBe('ok')
    const [co] = hs.list('companies'), [deal] = hs.list('deals')
    expect(co.id).not.toBe(oldCo); expect(hs.linked('deals', deal.id, 'companies', co.id)).toBe(true)
  })
  it('a deleted contact is rebuilt and linked', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.signed')); const oldCt = hs.list('contacts')[0].id, oldDeal = hs.list('deals')[0].id
    hs.remove('contacts', oldCt); hs.remove('deals', oldDeal)
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok')
    const [ct] = hs.list('contacts'), [deal] = hs.list('deals'); expect(ct.id).not.toBe(oldCt); expect(hs.linked('deals', deal.id, 'contacts', ct.id)).toBe(true)
  })
})

describe('notes are plain, escaped, bounded text', () => {
  it('escapes HTML from client-written text and caps the length', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('sow.declined', { reason: '<script>alert(1)</script> & <img src=x onerror=y>', summary: 'x'.repeat(5000), title: '<b>T</b>' }))
    const body = hs.list('notes')[0].properties.hs_note_body as string
    expect(body).not.toMatch(/<script|<img|<b>T/); expect(body).toContain('&lt;script&gt;'); expect(body.length).toBeLessThanOrEqual(2000)
  })
  it('timestamps the note with the EVENT time', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    await run(w, evt('invoice.paid', {}, { created_at: '2026-03-01T08:00:00.000Z' })); expect(hs.list('notes')[0].properties.hs_timestamp).toBe('2026-03-01T08:00:00.000Z')
  })
})

describe('refuses, without touching HubSpot, when there is nothing safe to do', () => {
  const cases: Array<[string, () => any, RegExp]> = [
    ['an event HubSpot does not act on', () => [world(), evt('sow.expired')], /does not act on/],
    ['an event with no project', () => [world(), evt('sow.signed', {}, { project_id: null })], /no project/],
    ['a non-uuid project id', () => [world(), evt('sow.signed', {}, { project_id: 'nope' })], /no project/],
    ["another workspace's project", () => [world({ project: { workspace_id: OTHER_WS } }), evt('sow.signed')], /no longer exists/],
    ['a project that does not exist', () => [world(), evt('sow.signed', {}, { project_id: '99999999-9999-4999-8999-999999999999' })], /no longer exists/],
    ['a deleted project', () => [world({ project: { deleted_at: '2026-01-01' } }), evt('sow.signed')], /deleted/],
  ]
  for (const [name, mk, msg] of cases) it(name, async () => {
    const [w, e] = mk(), hs = h.hs as FakeHubspot
    const r = await run(w, e); expect(r.verdict.outcome).toBe('permanent'); expect((r.verdict as any).error).toMatch(msg); expect(hs.calls).toHaveLength(0)
  })
})

describe('pipeline problems turn the RULE off, with the fix', () => {
  it('a pipeline that no longer exists', async () => {
    const w = world(); const r = await run(w, evt('sow.signed'), { rule: { config: { pipeline_id: 'deleted-pipeline' } } })
    expect(r.verdict).toMatchObject({ outcome: 'rule_off' }); expect((r.verdict as any).reason).toMatch(/no longer exists/); expect((h.hs as FakeHubspot).list('deals')).toHaveLength(0)
  })
  it('a pipeline without a Closed-won stage (or Closed-lost, for a decline)', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    hs.pipelines = [{ id: 'default', label: 'No close', stages: [{ id: 'a', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.1' } }] }]
    const r = await run(w, evt('sow.signed')); expect(r.verdict).toMatchObject({ outcome: 'rule_off' }); expect((r.verdict as any).reason).toMatch(/Closed won/)
    hs.pipelines = [{ id: 'default', label: 'Only won', stages: [{ id: 'w', displayOrder: 0, metadata: { isClosed: 'true', probability: '1.0' } }] }]
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok'); expect((await run(w, evt('sow.declined'))).verdict).toMatchObject({ outcome: 'rule_off' })
  })
  it('HubSpot rejecting the stage on create (pipeline edited meanwhile) is also a rule-off', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    const orig = hs.call.bind(hs); hs.call = async (req: any) => { if (req.method === 'POST' && req.url.endsWith('/objects/deals')) return { status: 400, json: { status: 'error', category: 'VALIDATION_ERROR', message: 'closedwon is not a valid dealstage' }, retryAfter: null }; return orig(req) }
    expect((await run(w, evt('sow.signed'), { call: hs.call })).verdict.outcome).toBe('rule_off')
  })
})

describe('HubSpot failures map to the right outcome', () => {
  it('rate limit and 5xx retry; then it works', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    hs.rateLimited = 1; expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('retry')
    hs.serverError = 1; expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('retry')
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok'); expect(hs.list('deals')).toHaveLength(1)
  })
  it('a revoked grant is a connection fault and no CRM call is made', async () => {
    const w = world(), hs = h.hs as FakeHubspot; hs.tokenError = 'BAD_REFRESH_TOKEN'
    const v = (await run(w, evt('sow.signed'))).verdict as any; expect(v.outcome).toBe('connection_off'); expect(v.reason).toMatch(/reconnected/i); expect(hs.calls.every(c => c.url.includes('/oauth/'))).toBe(true)
  })
  it('permissions withdrawn (MISSING_SCOPES) is a connection fault that says to accept all permissions', async () => {
    const w = world(), hs = h.hs as FakeHubspot; hs.missingScopes = true
    const v = (await run(w, evt('sow.signed'))).verdict as any; expect(v.outcome).toBe('connection_off'); expect(v.reason).toMatch(/all of the requested permissions/i)
  })
  it('an unreadable stored token sends nothing', async () => {
    const w = world(), hs = h.hs as FakeHubspot
    const v = (await run(w, evt('sow.signed'), { connection: { id: CONN, workspace_id: WS, credentials_enc: creds('rt', OTHER_WS) } })).verdict as any
    expect(v.outcome).toBe('connection_off'); expect(hs.calls).toHaveLength(0)
  })
  it('an access token that expired early is refreshed ONCE and the work continues', async () => {
    const w = world(), hs = h.hs as FakeHubspot; hs.reject401 = 1
    expect((await run(w, evt('sow.signed'))).verdict.outcome).toBe('ok'); expect(hs.tokensIssued).toBe(2); expect(hs.list('deals')).toHaveLength(1)
  })
  it('the access token is minted once and reused across events', async () => {
    const w = world(), hs = h.hs as FakeHubspot; await run(w, evt('sow.signed')); await run(w, evt('invoice.paid')); expect(hs.tokensIssued).toBe(1)
  })
  it('a network failure retries instead of throwing', async () => {
    const w = world()
    const call = async (req: any) => { if (req.url.includes('/oauth/')) return { status: 200, json: { access_token: 'hs-at-1', expires_in: 1800 }, retryAfter: null }; throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }
    const r = await run(w, evt('sow.signed'), { call }); expect(r.verdict.outcome).toBe('retry'); expect((r.verdict as any).error).toMatch(/in time/)
  })
  it('an unexpected exception retries rather than crashing the worker', async () => {
    const w = world(); const call = async (req: any) => { if (req.url.includes('/oauth/')) return { status: 200, json: { access_token: 'hs-at-1', expires_in: 1800 }, retryAfter: null }; return { status: 200, json: { results: 'not-an-array' }, retryAfter: null } }
    expect(['retry', 'rule_off', 'permanent']).toContain((await run(w, evt('sow.signed'), { call })).verdict.outcome)
  })
})

// ───────────────────────────── the delivery worker ─────────────────────────────
describe('HubSpot deliveries in the worker', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z')
  function deliveryWorld(over: { ws?: any; conn?: any; sub?: any; attempts?: number; project?: any } = {}) {
    const claimed = [{ id: 'd1', workspace_id: WS, subscription_id: RULE, event_id: 'ev-1', attempts: over.attempts ?? 1 }]
    const base = world({ project: over.project })
    return createFakeSupabase({
      integration_deliveries: claimed.map(c => ({ ...c, status: 'delivering' })),
      integration_subscriptions: [{ id: RULE, workspace_id: WS, connection_id: CONN, kind: 'hubspot', name: 'HubSpot sync', target_url: 'https://api.hubapi.com/crm/v3/objects', event_types: ['sow.signed'], secret_enc: null, active: true, consecutive_failures: 0, config: { pipeline_id: 'default', include_amounts: true }, ...over.sub }],
      integration_connections: [{ id: CONN, workspace_id: WS, status: 'active', credentials_enc: creds(), config: {}, ...over.conn }],
      integration_events: [{ id: 'ev-1', workspace_id: WS, event_type: 'sow.signed', entity_type: 'project', entity_id: PROJ, project_id: PROJ, data: { title: 'SOW signed', summary: 's', document: { type: 'sow', id: SOW } }, created_at: '2026-01-15T09:30:00.000Z' }],
      workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...over.ws }],
      projects: base.db.tables.projects, integration_external_refs: [],
    }, { rpc: { claim_integration_deliveries: () => ({ data: claimed }) } })
  }
  const run2 = (db: any, hubspot?: any) => processDeliveries(db.client, { now: () => NOW, send: vi.fn() as any, hubspot: hubspot || ((i: any) => syncEventToHubspot({ ...i, call: (h.hs as FakeHubspot).call, env: ENV })) })
  const d1 = (db: any) => db.tables.integration_deliveries[0], rule = (db: any) => db.tables.integration_subscriptions[0]

  it('end to end: syncs the project and marks the delivery succeeded, honouring the rule\'s config', async () => {
    const db = deliveryWorld(), hs = h.hs as FakeHubspot
    expect(await run2(db)).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(d1(db)).toMatchObject({ status: 'succeeded' }); expect(rule(db).last_success_at).toBeTruthy()
    expect(hs.list('deals')[0].properties).toMatchObject({ dealname: 'Website Redesign', dealstage: 'closedwon', amount: '12500' })
  })
  it('a redelivery after success creates nothing new (at-least-once delivery, exactly-once sync)', async () => {
    const db = deliveryWorld(), hs = h.hs as FakeHubspot
    await run2(db); db.tables.integration_deliveries[0].status = 'delivering'
    await run2(db); expect(hs.list('deals')).toHaveLength(1); expect(hs.list('notes')).toHaveLength(1)
  })
  it('a deleted project is dead for THAT delivery only and never counts against the rule', async () => {
    const db = deliveryWorld({ project: { deleted_at: '2026-01-01' }, sub: { consecutive_failures: 9 } }); await run2(db)
    expect(d1(db)).toMatchObject({ status: 'dead' }); expect(rule(db)).toMatchObject({ active: true, consecutive_failures: 9 })
  })
  it('a bad pipeline switches the rule off with the reason', async () => {
    const db = deliveryWorld({ sub: { config: { pipeline_id: 'gone' } } }); await run2(db)
    expect(rule(db).active).toBe(false); expect(rule(db).disabled_reason).toMatch(/pipeline/i)
  })
  it('a revoked grant flags the connection and switches the rule off ("reconnect")', async () => {
    const db = deliveryWorld(); (h.hs as FakeHubspot).tokenError = 'BAD_REFRESH_TOKEN'; await run2(db)
    expect(db.tables.integration_connections[0]).toMatchObject({ status: 'error' }); expect(rule(db).active).toBe(false); expect(rule(db).disabled_reason).toMatch(/reconnected/i)
  })
  it('transient failures retry with backoff; a thrown error retries too', async () => {
    const db = deliveryWorld(); (h.hs as FakeHubspot).serverError = 99; await run2(db)
    expect(d1(db).status).toBe('pending'); expect(Date.parse(d1(db).next_attempt_at)).toBeGreaterThan(NOW)
    const db2 = deliveryWorld(); await run2(db2, async () => { throw new Error('kaboom') }); expect(d1(db2).status).toBe('pending'); expect(d1(db2).last_error).toMatch(/kaboom/)
  })
  it('needs the Pro plan; skips when the connection needs reconnecting or the rule is off — never calling HubSpot', async () => {
    for (const over of [{ ws: { plan_tier: 'starter' } }, { conn: { status: 'error' } }, { sub: { active: false } }, { ws: { lapsed_at: '2026-10-01' } }]) {
      const db = deliveryWorld(over as any), fn = vi.fn(); await run2(db, fn)
      expect(d1(db).status, JSON.stringify(over)).toBe('skipped'); expect(fn).not.toHaveBeenCalled()
    }
  })
})

// ───────────────────────────── routes ─────────────────────────────
const req = (url: string, init: { method?: string; body?: unknown } = {}) => new NextRequest(`http://localhost${url}`, { method: init.method || 'GET', headers: { 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
const GOOD_EXCHANGE = { access_token: 'CJSh-access', refresh_token: 'na1-refresh-token', expires_in: 1800 }
function routeWorld(over: { conn?: any | null; rule?: any | null; refs?: any[]; sows?: any[]; events?: any[] } = {}) {
  h.db = createFakeSupabase({
    integration_connections: over.conn === null ? [] : [{ id: CONN, workspace_id: WS, provider: 'hubspot', status: 'active', display_name: 'agency.hubspot.test', config: { hub_id: '4242', hub_domain: 'agency.hubspot.test', user_email: 'ada@agency.com' }, credentials_enc: creds(), created_at: 'c', last_error: null, ...over.conn }],
    integration_subscriptions: over.rule === null ? [] : [{ id: RULE, workspace_id: WS, connection_id: CONN, kind: 'hubspot', name: 'HubSpot sync', target_url: 'https://api.hubapi.com/crm/v3/objects', event_types: ['sow.signed', 'sow.declined'], secret_enc: null, active: true, consecutive_failures: 0, config: { pipeline_id: 'default', include_amounts: false }, ...over.rule }],
    integration_external_refs: over.refs ?? [], integration_events: over.events ?? [], integration_deliveries: [], sow_documents: over.sows ?? [], audit_log: [],
    workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null }],
  })
  return h.db
}
const tbl = (n: string) => h.db.tables[n]

describe('POST /hubspot/connect', () => {
  beforeEach(() => routeWorld({ conn: null, rule: null }))
  it('returns the consent URL bound to this workspace and person', async () => {
    const r = await connect(); expect(r.status).toBe(200)
    const u = new URL((await r.json()).url); expect(u.hostname).toBe('app.hubspot.com')
    expect(verifyHubspotState(u.searchParams.get('state'))).toEqual({ ok: true, state: { ws: WS, uid: USER } })
  })
  it('needs login, the settings permission, permission to view client data, Pro, a recent re-authentication and server config', async () => {
    h.session = null; expect((await connect()).status).toBe(401)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: ['VIEW_CLIENT_DATA'] }; expect((await connect()).status).toBe(403)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }; const r = await connect(); expect(r.status).toBe(403); expect((await r.json()).error).toMatch(/VIEW_CLIENT_DATA/)
    h.session = { id: USER, workspaceId: WS, planTier: 'starter', permissions: ALL }; expect((await connect()).status).toBe(402)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: ALL }
    const { NextResponse } = await import('next/server'); h.stepUp = NextResponse.json({ code: 'step_up_required' }, { status: 401 }); expect((await connect()).status).toBe(401); h.stepUp = null
    delete process.env.HUBSPOT_CLIENT_SECRET; expect((await connect()).status).toBe(503)
  })
})

describe('GET /hubspot/callback', () => {
  const state = () => signHubspotState({ ws: WS, uid: USER })
  const go = async (qs: string) => { const r = await callback(new NextRequest(`http://localhost/api/integrations/hubspot/callback?${qs}`)); return new URL(r.headers.get('location')!).searchParams.get('hubspot') }
  beforeEach(() => { routeWorld({ conn: null, rule: null }); (h.hs as FakeHubspot).exchange = GOOD_EXCHANGE })

  it('connects: stores the REFRESH token encrypted (never the access token), picks the default pipeline, creates the rule, audits', async () => {
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    const c = tbl('integration_connections')[0]
    expect(c).toMatchObject({ workspace_id: WS, provider: 'hubspot', status: 'active', created_by: USER, display_name: 'agency.hubspot.test', config: { hub_id: '4242', hub_domain: 'agency.hubspot.test', user_email: 'ada@agency.com' } })
    expect(JSON.stringify(c)).not.toMatch(/na1-refresh-token|CJSh-access/)
    expect(JSON.parse(decryptSecret(c.credentials_enc, `${WS}:${c.id}`))).toEqual({ refresh_token: 'na1-refresh-token' }); expect(() => decryptSecret(c.credentials_enc, `${OTHER_WS}:${c.id}`)).toThrow()
    const rule = tbl('integration_subscriptions')[0]
    expect(rule).toMatchObject({ kind: 'hubspot', connection_id: c.id, secret_enc: null, config: { pipeline_id: 'default', include_amounts: false } })
    expect(rule.event_types.sort()).toEqual(Object.keys(HUBSPOT_EVENT_PERMISSIONS).sort())
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.hubspot_connected' })
    expect((h.hs as FakeHubspot).calls[0].form).toMatchObject({ grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://app.example.com/api/integrations/hubspot/callback' })
  })
  it('amounts are OFF after connecting, whatever the person can see (opt-in only)', async () => {
    await go(`code=abc&state=${state()}`); expect(tbl('integration_subscriptions')[0].config.include_amounts).toBe(false)
  })
  it('the rule starts with only the events this person may see', async () => {
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'VIEW_CLIENT_DATA', 'SEND_SOW'] }
    await go(`code=abc&state=${state()}`); expect(tbl('integration_subscriptions')[0].event_types.sort()).toEqual(['sow.declined', 'sow.signed'])
  })
  it('refuses forged / expired / other-integration states, the wrong person or workspace — without calling HubSpot', async () => {
    const hs = h.hs as FakeHubspot
    expect(await go('code=abc&state=garbage')).toBe('failed'); expect(await go('code=abc')).toBe('failed')
    expect(await go(`code=abc&state=${signSlackState({ ws: WS, uid: USER })}`)).toBe('failed'); expect(await go(`code=abc&state=${signGoogleState({ ws: WS, uid: USER })}`)).toBe('failed')
    expect(await go(`code=abc&state=${signHubspotState({ ws: WS, uid: USER }, Date.now() - 11 * 60_000)}`)).toBe('expired')
    h.session = { ...h.session, id: 'someone-else' }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = { ...h.session, id: USER, workspaceId: OTHER_WS }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = null; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    expect(hs.calls).toHaveLength(0); expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('refuses without the settings permission, WITHOUT permission to view client data, when lapsed, or below Pro', async () => {
    h.session = { ...h.session, permissions: ['VIEW_CLIENT_DATA'] }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS'] }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, permissions: ALL, lapsed: true }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, lapsed: false, planTier: 'starter' }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('handles Cancel on HubSpot\'s page', async () => { expect(await go(`error=access_denied&state=${state()}`)).toBe('denied') })
  it('a bad / used code, or no refresh token, fails cleanly and keeps nothing', async () => {
    ;(h.hs as FakeHubspot).exchange = null; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    ;(h.hs as FakeHubspot).exchange = { access_token: 'a', expires_in: 1800 }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    expect(tbl('integration_connections')).toHaveLength(0)
  })
  it('not every permission granted: nothing is kept and the token is REVOKED', async () => {
    const hs = h.hs as FakeHubspot; hs.tokenInfo = { ...hs.tokenInfo, scopes: ['crm.objects.contacts.read'] }
    expect(await go(`code=abc&state=${state()}`)).toBe('scope'); expect(tbl('integration_connections')).toHaveLength(0); expect(hs.revoked).toEqual(['na1-refresh-token'])
  })
  it('the Deals API unusable (no pipelines): reported at connect time, nothing kept, token revoked', async () => {
    const hs = h.hs as FakeHubspot; hs.pipelines = []
    expect(await go(`code=abc&state=${state()}`)).toBe('api'); expect(tbl('integration_connections')).toHaveLength(0); expect(tbl('integration_subscriptions')).toHaveLength(0); expect(hs.revoked).toEqual(['na1-refresh-token'])
  })
  it('uses the portal\'s DEFAULT pipeline, or the first one if there is no "default"', async () => {
    const hs = h.hs as FakeHubspot; hs.pipelines = [{ ...PIPELINE, id: '111', label: 'A' }, { ...PIPELINE, id: '222', label: 'B' }]
    await go(`code=abc&state=${state()}`); expect(tbl('integration_subscriptions')[0].config.pipeline_id).toBe('111')
  })
  it('RECONNECTING the same portal keeps the records and revives a rule a dead token turned off', async () => {
    routeWorld({ rule: { active: false, disabled_reason: 'HubSpot needs to be reconnected (access was revoked or expired).', consecutive_failures: 10, config: { pipeline_id: 'custom', include_amounts: true } }, conn: { status: 'error', last_error: 'x' },
      refs: [{ id: 'r1', workspace_id: WS, connection_id: CONN, ref_type: 'deal', local_key: `deal:${PROJ}`, remote_id: 'd1' }] })
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    expect(tbl('integration_connections')).toHaveLength(1); expect(tbl('integration_connections')[0]).toMatchObject({ id: CONN, status: 'active', last_error: null })
    expect(tbl('integration_subscriptions')[0]).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0, config: { pipeline_id: 'custom', include_amounts: true } })
    expect(tbl('integration_external_refs').some((r: any) => r.id === 'r1')).toBe(true)
  })
  it('a rule the admin turned off by hand stays off after a reconnect', async () => {
    routeWorld({ rule: { active: false, disabled_reason: null } }); await go(`code=abc&state=${state()}`); expect(tbl('integration_subscriptions')[0].active).toBe(false)
  })
  it('connecting a DIFFERENT HubSpot portal forgets the old portal\'s records and re-picks the pipeline there', async () => {
    routeWorld({ refs: [{ id: 'r1', workspace_id: WS, connection_id: CONN, ref_type: 'deal', local_key: `deal:${PROJ}`, remote_id: 'd1' }], rule: { config: { pipeline_id: 'old-portal-pipeline', include_amounts: true } } })
    ;(h.hs as FakeHubspot).tokenInfo = { ...(h.hs as FakeHubspot).tokenInfo, hub_id: 9999, hub_domain: 'other.hubspot.test' }
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    expect(tbl('integration_external_refs').some((r: any) => r.id === 'r1')).toBe(false)
    expect(tbl('integration_connections')[0].config.hub_id).toBe('9999'); expect(tbl('integration_subscriptions')[0].config).toMatchObject({ pipeline_id: 'default', include_amounts: true })
  })
})

describe('DELETE /hubspot (disconnect)', () => {
  it('revokes the refresh token, forgets the connection, audits — and leaves everything in HubSpot alone', async () => {
    routeWorld(); const hs = h.hs as FakeHubspot; hs.add('deals', { dealname: 'keep me' })
    expect((await disconnect()).status).toBe(200)
    expect(hs.revoked).toEqual(['rt-hs']); expect(tbl('integration_connections')).toHaveLength(0); expect(hs.list('deals')).toHaveLength(1)
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.hubspot_disconnected' })
  })
  it('works on any plan, with an unreadable token, and as a no-op when not connected', async () => {
    routeWorld({ conn: { credentials_enc: 'garbage' } }); h.session = { ...h.session, planTier: 'solo' }
    expect((await disconnect()).status).toBe(200); expect(tbl('integration_connections')).toHaveLength(0); expect((await disconnect()).status).toBe(200)
  })
  it('requires the permission', async () => { routeWorld(); h.session = { ...h.session, permissions: [] }; expect((await disconnect()).status).toBe(403) })
})

describe('PATCH /hubspot (the sync rule)', () => {
  const patch = (body: unknown) => patchRule(req('/x', { method: 'PATCH', body }))
  beforeEach(() => routeWorld())
  it('changes events (permission-checked per event; only the five supported)', async () => {
    expect((await patch({ events: ['sow.signed'] })).status).toBe(200); expect(tbl('integration_subscriptions')[0].event_types).toEqual(['sow.signed'])
    expect((await patch({ events: ['invoice.sent'] })).status).toBe(400); expect((await patch({ events: 'sow.signed' })).status).toBe(400)
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'SEND_SOW'] }
    const r = await patch({ events: ['sow.signed', 'invoice.paid'] }); expect(r.status).toBe(403); expect((await r.json()).error).toMatch(/VIEW_FINANCIALS/)
  })
  it('sending deal amounts needs permission to view financials; turning it off never does', async () => {
    expect((await patch({ include_amounts: true })).status).toBe(200); expect(tbl('integration_subscriptions')[0].config).toMatchObject({ pipeline_id: 'default', include_amounts: true })
    // Someone WITHOUT financial access can neither switch amounts on ...
    routeWorld(); h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'VIEW_CLIENT_DATA'] }
    const r = await patch({ include_amounts: true }); expect(r.status).toBe(403); expect((await r.json()).error).toMatch(/VIEW_FINANCIALS/); expect(tbl('integration_subscriptions')[0].config.include_amounts).toBe(false)
    // ... but CAN switch them off (turning data sharing off never needs the permission).
    routeWorld({ rule: { config: { pipeline_id: 'default', include_amounts: true } } }); h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'VIEW_CLIENT_DATA'] }
    expect((await patch({ include_amounts: false })).status).toBe(200); expect(tbl('integration_subscriptions')[0].config.include_amounts).toBe(false)
    expect((await patch({ include_amounts: 'yes' })).status).toBe(400)
  })
  it('a pipeline is verified WITH HUBSPOT and must have Closed-won and Closed-lost stages', async () => {
    const hs = h.hs as FakeHubspot; hs.pipelines = [PIPELINE, { id: 'p2', label: 'Retainers', stages: [{ id: 'w', displayOrder: 1, metadata: { isClosed: 'true', probability: '1.0' } }, { id: 'l', displayOrder: 2, metadata: { isClosed: 'true', probability: '0.0' } }] }, { id: 'p3', label: 'Open only', stages: [{ id: 'o', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.1' } }] }]
    expect((await patch({ pipeline_id: 'p2' })).status).toBe(200); expect(tbl('integration_subscriptions')[0].config.pipeline_id).toBe('p2')
    const bad = await patch({ pipeline_id: 'p3' }); expect(bad.status).toBe(400); expect((await bad.json()).error).toMatch(/Closed won.*Closed lost/)
    expect((await patch({ pipeline_id: 'nope' })).status).toBe(400); expect((await patch({ pipeline_id: '../etc' })).status).toBe(400); expect((await patch({ pipeline_id: 42 })).status).toBe(400)
    expect(tbl('integration_subscriptions')[0].config.pipeline_id).toBe('p2')
  })
  it('toggles; turning on needs a live connection and clears the failure streak', async () => {
    routeWorld({ rule: { active: false, disabled_reason: 'x', consecutive_failures: 7 } })
    expect((await patch({ active: true })).status).toBe(200); expect(tbl('integration_subscriptions')[0]).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0 })
    routeWorld({ rule: { active: false }, conn: { status: 'error' } }); const r = await patch({ active: true }); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true)
  })
  it('validates, and needs a connection and Pro', async () => {
    expect((await patch({})).status).toBe(400); expect((await patch({ active: 'yes' })).status).toBe(400); expect((await patch(undefined)).status).toBe(400)
    routeWorld({ conn: null, rule: null }); expect((await patch({ active: true })).status).toBe(409)
    routeWorld(); h.session = { ...h.session, planTier: 'starter' }; expect((await patch({ active: false })).status).toBe(402)
  })
  it('a dead token found while verifying a pipeline flags the connection', async () => {
    routeWorld(); (h.hs as FakeHubspot).tokenError = 'BAD_REFRESH_TOKEN'
    const r = await patch({ pipeline_id: 'default' }); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true); expect(tbl('integration_connections')[0].status).toBe('error'); expect(tbl('integration_subscriptions')[0].active).toBe(false)
  })
})

describe('GET /hubspot/pipelines', () => {
  it('lists only the pipelines the sync can use', async () => {
    routeWorld(); const hs = h.hs as FakeHubspot; hs.pipelines = [PIPELINE, { id: 'open-only', label: 'No close', stages: [{ id: 'o', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.1' } }] }]
    expect(await (await listPipelines()).json()).toEqual({ pipelines: [{ id: 'default', label: 'Sales Pipeline' }] })
  })
  it('409 when not connected; a dead token answers "reconnect"', async () => {
    routeWorld({ conn: null }); expect((await listPipelines()).status).toBe(409)
    routeWorld(); (h.hs as FakeHubspot).tokenError = 'BAD_REFRESH_TOKEN'; const r = await listPipelines(); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true)
  })
})

describe('POST /hubspot/backfill', () => {
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const sow = (id: string, project: string, over: any = {}) => ({ id, workspace_id: WS, project_id: project, status: 'signed', signed_at: '2026-01-01', ...over })
  const run3 = () => backfill()
  it('queues ONE event per project with a signed SOW and no deal yet, through the normal queue, flagged as history', async () => {
    routeWorld({ sows: [sow(U(1), U(101)), sow(U(2), U(101), { signed_at: '2025-01-01' }), sow(U(3), U(102)), sow(U(4), U(103)), sow(U(5), U(104), { status: 'sent' }), sow(U(6), U(105), { workspace_id: OTHER_WS })],
      refs: [{ id: 'x', workspace_id: WS, connection_id: CONN, ref_type: 'deal', local_key: `deal:${U(103)}`, remote_id: 'd' }] })
    const r = await run3(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ queued: 2, alreadySynced: 1, capped: false })
    const ev = tbl('integration_events'); expect(ev.map((e: any) => e.project_id).sort()).toEqual([U(101), U(102)])
    expect(ev.every((e: any) => e.event_type === 'sow.signed' && e.entity_type === 'hubspot_backfill' && e.workspace_id === WS && e.data.backfill === true && e.data.document.type === 'sow')).toBe(true)
    expect(tbl('integration_deliveries').every((d: any) => d.subscription_id === RULE && d.workspace_id === WS)).toBe(true); expect(tbl('integration_deliveries')).toHaveLength(2)
    expect(tbl('audit_log')[0]).toMatchObject({ event_type: 'workspace.hubspot_backfill' })
  })
  it('is bounded to 200 projects per click and says so', async () => {
    routeWorld({ sows: Array.from({ length: HUBSPOT_BACKFILL_LIMIT + 30 }, (_, i) => sow(U(i + 1), U(i + 5000))) })
    expect(await (await run3()).json()).toMatchObject({ queued: HUBSPOT_BACKFILL_LIMIT, capped: true })
  })
  it('a second click within ten minutes is refused and queues nothing more', async () => {
    routeWorld({ sows: [sow(U(1), U(101))] }); expect((await run3()).status).toBe(200); expect((await run3()).status).toBe(429); expect(tbl('integration_events')).toHaveLength(1)
  })
  it('needs: a live connection, an ON rule that creates deals (SOW signed), SEND_SOW and Pro', async () => {
    routeWorld({ conn: null, rule: null }); expect((await run3()).status).toBe(409)
    routeWorld({ conn: { status: 'error' } }); expect((await (await run3()).json()).reconnect).toBe(true)
    routeWorld({ rule: { active: false } }); expect((await run3()).status).toBe(409)
    routeWorld({ rule: { event_types: ['invoice.paid'] } }); const r = await run3(); expect(r.status).toBe(409); expect((await r.json()).error).toMatch(/SOW signed/)
    routeWorld(); h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'VIEW_CLIENT_DATA'] }; expect((await run3()).status).toBe(403)
    routeWorld(); h.session = { ...h.session, permissions: ALL, planTier: 'starter' }; expect((await run3()).status).toBe(402)
  })
  it('nothing to sync is a quiet success', async () => { routeWorld({ sows: [] }); expect(await (await run3()).json()).toEqual({ queued: 0, alreadySynced: 0, capped: false }) })
})

describe('GET /integrations overview: the HubSpot block', () => {
  it('not connected', async () => {
    routeWorld({ conn: null, rule: null }); expect((await (await overview()).json()).hubspot).toMatchObject({ configured: true, allowed: true, connection: null, rule: null, deals: 0 })
  })
  it('connected: portal, deals synced, the rule and its settings; never a token; not listed as a webhook', async () => {
    routeWorld({ rule: { config: { pipeline_id: 'p9', include_amounts: true } }, refs: [{ id: '1', workspace_id: WS, connection_id: CONN, ref_type: 'deal', local_key: 'deal:a', remote_id: 'd1' }, { id: '2', workspace_id: WS, connection_id: CONN, ref_type: 'company', local_key: 'company:a', remote_id: 'c1' }] })
    const j = await (await overview()).json()
    expect(j.hubspot.connection).toMatchObject({ portal: 'agency.hubspot.test', user_email: 'ada@agency.com', status: 'active', open_url: 'https://app.hubspot.com/contacts/4242/objects/0-3/views/all/list' })
    expect(j.hubspot.deals).toBe(1); expect(j.hubspot.rule).toMatchObject({ active: true, pipeline_id: 'p9', include_amounts: true, event_types: ['sow.signed', 'sow.declined'] })
    expect(j.subscriptions).toHaveLength(0); expect(JSON.stringify(j)).not.toMatch(/refresh|credentials|rt-hs/)
  })
})

describe('docs stay honest', () => {
  it('the HubSpot README names the exact redirect path and every scope the code requests', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'hubspot', 'README.md'), 'utf8')
    expect(md).toContain('/api/integrations/hubspot/callback')
    for (const s of HUBSPOT_SCOPES) expect(md, s).toContain(s)
    expect(md).not.toMatch(/crm\.schemas/)
  })
})
