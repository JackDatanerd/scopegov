import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, session: null as any, stepUp: null as any, slack: null as any, slackCalls: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: (s: any, p: string) => !!s?.permissions?.includes(p) }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => h.stepUp }))
vi.mock('@/lib/integrations/slack', async (orig) => ({ ...(await orig<any>()), slackCall: async (...a: any[]) => { h.slackCalls.push(a); return h.slack(...a) } }))

import { SLACK_SCOPES, signState, verifyState, slackAuthorizeUrl, slackConfigured, slackRedirectUri, STATE_TTL_MS } from '@/lib/integrations/slack-config'
import { classifySlack } from '@/lib/integrations/slack'
import { buildSlackMessage } from '@/lib/integrations/slack-message'
import { EVENT_CATALOG, sampleEnvelope } from '@/lib/integrations/event-catalog'
import { encryptSecret, decryptSecret } from '@/lib/integrations/crypto'
import { processDeliveries } from '@/lib/integrations/delivery'
import { MAX_SLACK_RULES } from '@/lib/integrations/plans'
import { POST as connect } from '@/app/api/workspace/integrations/slack/connect/route'
import { GET as callback } from '@/app/api/integrations/slack/callback/route'
import { DELETE as disconnect } from '@/app/api/workspace/integrations/slack/route'
import { GET as listChannels } from '@/app/api/workspace/integrations/slack/channels/route'
import { POST as createRule } from '@/app/api/workspace/integrations/slack/rules/route'
import { PATCH as patchRule, DELETE as deleteRule } from '@/app/api/workspace/integrations/slack/rules/[id]/route'
import { POST as testRule } from '@/app/api/workspace/integrations/slack/rules/[id]/test/route'
import { PATCH as patchWebhook, DELETE as deleteWebhook } from '@/app/api/workspace/integrations/webhooks/[id]/route'

const KEY = randomBytes(32).toString('base64')
const WS = '0f1e2d3c-4b5a-4968-8776-655443322110', USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONN = '55555555-5555-4555-8555-555555555555'
const RULE = '66666666-6666-4666-8666-666666666666', PROJ = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'
const ENV = { INTEGRATIONS_ENCRYPTION_KEY: KEY, SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'csecret', NEXT_PUBLIC_APP_URL: 'https://app.example.com' } as unknown as NodeJS.ProcessEnv
const ALL = ['SEND_SOW', 'SEND_CHANGE_ORDERS', 'APPROVE_FLAGS', 'VIEW_FINANCIALS', 'MANAGE_WORKSPACE_SETTINGS']

beforeEach(() => {
  Object.assign(process.env, ENV)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.session = { id: USER, name: 'Ada', email: 'ada@acme.com', workspaceId: WS, planTier: 'pro', lapsed: false, permissions: ALL }
  h.stepUp = null; h.slackCalls.length = 0
  h.slack = async () => ({ status: 200, retryAfter: null, body: { ok: true } })
})

const tokenBlob = (token = 'xoxb-live-token') => encryptSecret(JSON.stringify({ access_token: token }), `${WS}:${CONN}`)
function world(over: { conn?: any | null; subs?: any[]; ws?: any } = {}) {
  h.db = createFakeSupabase({
    integration_connections: over.conn === null ? [] : [{ id: CONN, workspace_id: WS, provider: 'slack', status: 'active', display_name: 'Acme', config: { team_id: 'T1', team_name: 'Acme' }, credentials_enc: tokenBlob(), created_at: 'c', last_error: null, ...over.conn }],
    integration_subscriptions: over.subs ?? [],
    workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...over.ws }],
    audit_log: [],
  }, { unique: (t, row, existing) => t === 'integration_subscriptions' && row.kind === 'slack' && existing.some(e => e.kind === 'slack' && e.connection_id === row.connection_id && e.config?.channel_id === row.config?.channel_id) })
  return h.db
}
const rule = (over: any = {}) => ({ id: RULE, workspace_id: WS, connection_id: CONN, kind: 'slack', name: '#general', target_url: 'https://slack.com/api/chat.postMessage', event_types: ['sow.signed'], secret_enc: null, active: true, consecutive_failures: 0, config: { channel_id: 'C0123456789', channel_name: 'general', is_private: false }, ...over })
const req = (url: string, init: { method?: string; body?: unknown } = {}) => new NextRequest(`http://localhost${url}`, { method: init.method || 'GET', headers: { 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const subs = () => h.db.tables.integration_subscriptions
const conns = () => h.db.tables.integration_connections

describe('OAuth state', () => {
  const NOW = 1_800_000_000_000
  it('round-trips workspace and user', () => {
    expect(verifyState(signState({ ws: WS, uid: USER }, NOW, ENV), NOW + 1000, ENV)).toEqual({ ok: true, state: { ws: WS, uid: USER } })
  })
  it('rejects tampering, another key, expiry, and malformed input', () => {
    const t = signState({ ws: WS, uid: USER }, NOW, ENV)
    const [p, s] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ ws: 'other', uid: USER, exp: NOW + 99999999 })).toString('base64url')
    expect(verifyState(`${forged}.${s}`, NOW, ENV)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyState(`${p}.${s}x`, NOW, ENV)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyState(t, NOW, { ...ENV, INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as any)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyState(t, NOW + STATE_TTL_MS + 1, ENV)).toEqual({ ok: false, reason: 'expired' })
    for (const bad of [null, '', 'x', 'a.b.c', undefined]) expect(verifyState(bad as any, NOW, ENV).ok).toBe(false)
  })
  it('two states for the same person differ (nonce)', () => {
    expect(signState({ ws: WS, uid: USER }, NOW, ENV)).not.toBe(signState({ ws: WS, uid: USER }, NOW, ENV))
  })
  it('refuses to sign with no server key', () => { expect(() => signState({ ws: WS, uid: USER }, NOW, {} as any)).toThrow(/not configured/) })
  it('builds the authorize URL from the app URL, client id and the exact scopes', () => {
    const u = new URL(slackAuthorizeUrl('STATE', ENV)!)
    expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(u.searchParams.get('client_id')).toBe('cid'); expect(u.searchParams.get('state')).toBe('STATE')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/integrations/slack/callback')
    expect(u.searchParams.get('scope')).toBe(SLACK_SCOPES.join(','))
    expect(slackAuthorizeUrl('s', { ...ENV, NEXT_PUBLIC_APP_URL: '' } as any)).toBeNull()
    expect(slackConfigured({} as any)).toBe(false); expect(slackRedirectUri({ NEXT_PUBLIC_APP_URL: 'https://x.co/' } as any)).toBe('https://x.co/api/integrations/slack/callback')
  })
  it('the committed Slack app manifest matches the code (scopes and callback path)', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'integrations', 'slack', 'manifest.json'), 'utf8'))
    expect([...m.oauth_config.scopes.bot].sort()).toEqual([...SLACK_SCOPES].sort())
    expect(m.oauth_config.redirect_urls[0]).toMatch(/\/api\/integrations\/slack\/callback$/)
    expect(m.settings.token_rotation_enabled).toBe(false) // tokens are stored as non-expiring bot tokens
  })
})

describe('classifySlack (the body decides, not the status)', () => {
  const c = (status: number, body: any, retryAfter: string | null = null) => classifySlack({ status, body, retryAfter })
  it('ok', () => { expect(c(200, { ok: true }).outcome).toBe('ok') })
  it('rate limits and outages retry', () => {
    expect(c(429, null).outcome).toBe('retry'); expect(c(503, null).outcome).toBe('retry')
    for (const e of ['ratelimited', 'internal_error', 'service_unavailable', 'fatal_error', 'something_new']) expect(c(200, { ok: false, error: e }).outcome, e).toBe('retry')
    expect(c(200, null).outcome).toBe('retry')
  })
  it('a dead token is a CONNECTION fault', () => {
    for (const e of ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'missing_scope']) expect(c(200, { ok: false, error: e }).outcome, e).toBe('connection_off')
  })
  it('a missing/archived/uninvited channel switches only that rule off, with a useful reason', () => {
    for (const e of ['channel_not_found', 'is_archived', 'not_in_channel']) expect(c(200, { ok: false, error: e }).outcome, e).toBe('channel_off')
    expect((c(200, { ok: false, error: 'not_in_channel' }) as any).reason).toMatch(/invite/i)
  })
  it('a malformed message is permanent but does not blame the rule', () => {
    for (const e of ['msg_too_long', 'invalid_blocks', 'no_text']) expect(c(200, { ok: false, error: e }).outcome, e).toBe('permanent')
  })
})

describe('Slack message', () => {
  const env = (over: any = {}) => ({ id: 'e', type: 'sow.signed', project_id: PROJ, project: { id: PROJ, name: 'Website Redesign', status: 'Active', currency: 'USD' }, client: { id: 'c', name: 'Acme Ltd' }, data: { title: 't', summary: 'Jane signed.' }, ...over })
  const allText = (m: any) => JSON.stringify(m.blocks) + m.text

  it('CLIENT-written text cannot @channel, mention a person, or forge a link', () => {
    const evil = '<!channel> <!here> <@U123ABC> <#C123|general> <https://evil.example/login|Click here> & more'
    for (const key of ['reason', 'feedback', 'dispute_note', 'counter_note', 'claim_note']) {
      const m = buildSlackMessage(env({ type: 'sow.declined', data: { summary: evil, [key]: evil } }), { appUrl: 'https://app.example.com' })
      const json = allText(m)
      expect(json, key).not.toMatch(/<!channel>|<!here>|<@U|<#C|<https:\/\/evil/)
      expect(json, key).toContain('&lt;!channel&gt;')
    }
    const m = buildSlackMessage(env({ project: { name: '<!channel> Site', currency: 'USD' }, client: { name: '<@U1>' } }), {})
    expect(allText(m)).not.toMatch(/<!channel>|<@U1>/)
  })
  it('a plain "@channel" in client text is left as text (and the message never asks Slack to link names)', () => {
    const m: any = buildSlackMessage(env({ data: { summary: 'ping @channel please', reason: '@here now' } }), {})
    expect(JSON.stringify(m)).toContain('@channel'); expect(m.link_names).toBeUndefined()
  })
  it('the button points at the right project tab for each event family, and is absent without an app URL', () => {
    const tabs: Record<string, string> = { 'sow.signed': 'sow', 'change_order.accepted': 'co', 'guardian.flag_raised': 'guardian', 'invoice.paid': 'billing', 'milestone.overdue': 'billing', 'retainer.ending': 'billing' }
    for (const [type, tab] of Object.entries(tabs)) {
      const m = buildSlackMessage(env({ type }), { appUrl: 'https://app.example.com/' })
      expect(m.blocks.at(-1).elements[0].url, type).toBe(`https://app.example.com/projects/${PROJ}?tab=${tab}`)
    }
    expect(buildSlackMessage(env(), {}).blocks.some((b: any) => b.type === 'actions')).toBe(false)
    expect(buildSlackMessage(env(), { appUrl: 'javascript:alert(1)' }).blocks.some((b: any) => b.type === 'actions')).toBe(false)
    expect(buildSlackMessage(env({ project_id: 'not-a-uuid' }), { appUrl: 'https://a.co' }).blocks.some((b: any) => b.type === 'actions')).toBe(false)
  })
  it('every catalog event yields a message that respects Slack limits, with a sane fallback text', () => {
    for (const e of EVENT_CATALOG) {
      const m = buildSlackMessage(sampleEnvelope(e), { appUrl: 'https://app.example.com' })
      expect(m.text.length, e.type).toBeGreaterThan(3); expect(m.text.length).toBeLessThanOrEqual(200)
      expect(m.blocks.length, e.type).toBeLessThanOrEqual(50)
      for (const b of m.blocks) {
        if (b.text) expect(b.text.text.length, e.type).toBeLessThanOrEqual(3000)
        if (b.fields) { expect(b.fields.length).toBeLessThanOrEqual(10); for (const f of b.fields) expect(f.text.length).toBeLessThanOrEqual(2000) }
        if (b.type === 'actions') expect(b.elements[0].text.text.length).toBeLessThanOrEqual(75)
      }
      expect(m.blocks[0].type).toBe('section')
    }
  })
  it('huge input is clipped, not rejected by Slack', () => {
    const big = 'x'.repeat(50_000)
    const m = buildSlackMessage(env({ data: { summary: big, reason: big, document: { type: 'invoice', title: big, number: big, amount: 1, currency: 'USD' } }, project: { name: big, currency: 'USD' }, client: { name: big } }), { appUrl: 'https://a.co' })
    expect(JSON.stringify(m).length).toBeLessThan(12_000)
    for (const b of m.blocks) { if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000); for (const f of b.fields || []) expect(f.text.length).toBeLessThanOrEqual(2000) }
  })
  it('shows the facts a person wants: invoice number, amount, balance, due date, payment method', () => {
    const m = buildSlackMessage(sampleEnvelope(EVENT_CATALOG.find(e => e.type === 'invoice.paid')!), { appUrl: 'https://a.co' })
    const t = allText(m)
    expect(t).toContain('INV-0042'); expect(t).toContain('$2,500.00'); expect(t).toContain('bank_transfer'); expect(t).toContain('2026-02-07')
  })
  it('the test event reads as a test, and an unknown event still renders', () => {
    const t = buildSlackMessage({ type: 'integration.test', data: { message: 'It works.' } }, {})
    expect(allText(t)).toContain('ScopeGov is connected'); expect(allText(t)).toContain('It works.')
    expect(buildSlackMessage({ type: 'future.thing', data: {} }, {}).blocks.length).toBeGreaterThan(0)
  })
})

describe('delivery to Slack', () => {
  const EV = 'ev-1'
  const NOW = Date.parse('2026-11-01T12:00:00Z')
  function slackWorld(over: { conn?: any; sub?: any; ws?: any; attempts?: number } = {}) {
    const claimed = [{ id: 'd1', workspace_id: WS, subscription_id: RULE, event_id: EV, attempts: over.attempts ?? 1 }]
    const db = createFakeSupabase({
      integration_deliveries: claimed.map(c => ({ ...c, status: 'delivering' })),
      integration_subscriptions: [rule(over.sub), rule({ id: 'sibling', config: { channel_id: 'C9999999999', channel_name: 'other' } })],
      integration_connections: [{ id: CONN, workspace_id: WS, status: 'active', credentials_enc: tokenBlob(), config: { team_id: 'T1' }, ...over.conn }],
      integration_events: [{ id: EV, workspace_id: WS, event_type: 'sow.signed', entity_type: 'project', entity_id: PROJ, project_id: PROJ, data: { title: 'SOW signed', summary: 'Jane signed.' }, created_at: 'now' }],
      workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...over.ws }],
      projects: [{ id: PROJ, name: 'Website Redesign', status: 'Active', currency: 'USD', client_id: 'c', clients: { id: 'c', name: 'Acme Ltd' } }],
    }, { rpc: { claim_integration_deliveries: () => ({ data: claimed }) } })
    return db
  }
  const run = (db: any, slack: any) => processDeliveries(db.client, { now: () => NOW, slack, send: vi.fn() as any })
  const d = (db: any) => db.tables.integration_deliveries[0]
  const s = (db: any, id = RULE) => db.tables.integration_subscriptions.find((x: any) => x.id === id)
  const answer = (body: any, status = 200, retryAfter: string | null = null) => vi.fn(async () => ({ status, retryAfter, body }))

  it('posts a Block Kit message to the rule\'s channel with the DECRYPTED token, and marks it succeeded', async () => {
    const db = slackWorld(); const slack = answer({ ok: true })
    expect(await run(db, slack)).toMatchObject({ claimed: 1, succeeded: 1 })
    const [method, token, payload] = slack.mock.calls[0] as any
    expect(method).toBe('chat.postMessage'); expect(token).toBe('xoxb-live-token')
    expect(payload).toMatchObject({ channel: 'C0123456789', unfurl_links: false, unfurl_media: false })
    expect(payload.text).toContain('SOW signed'); expect(JSON.stringify(payload.blocks)).toContain('Website Redesign')
    expect(d(db)).toMatchObject({ status: 'succeeded', last_status: 200 })
    expect(JSON.stringify(payload)).not.toContain('xoxb')
  })
  it('a 429 / ratelimited answer retries, honouring Retry-After', async () => {
    const db = slackWorld(); await run(db, answer(null, 429, '120'))
    expect(d(db)).toMatchObject({ status: 'pending' }); expect(Date.parse(d(db).next_attempt_at) - NOW).toBe(120_000)
    const db2 = slackWorld(); await run(db2, answer({ ok: false, error: 'ratelimited' }))
    expect(d(db2).status).toBe('pending')
  })
  it('a network failure / timeout retries', async () => {
    const db = slackWorld(); await run(db, vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }))
    expect(d(db).status).toBe('pending'); expect(d(db).last_error).toMatch(/did not answer/)
  })
  it('channel_not_found switches THAT rule off at once, leaving its sibling and the connection alone', async () => {
    const db = slackWorld(); await run(db, answer({ ok: false, error: 'channel_not_found' }))
    expect(d(db).status).toBe('dead'); expect(s(db)).toMatchObject({ active: false }); expect(s(db).disabled_reason).toMatch(/channel/i)
    expect(s(db, 'sibling').active).toBe(true); expect(db.tables.integration_connections[0].status).toBe('active')
  })
  it('not_in_channel tells the admin to invite the app', async () => {
    const db = slackWorld(); await run(db, answer({ ok: false, error: 'not_in_channel' }))
    expect(s(db).disabled_reason).toMatch(/invite/i)
  })
  it('a revoked token flags the CONNECTION and switches every rule off with a reconnect message', async () => {
    const db = slackWorld(); await run(db, answer({ ok: false, error: 'token_revoked' }))
    expect(d(db).status).toBe('dead')
    expect(db.tables.integration_connections[0]).toMatchObject({ status: 'error' }); expect(db.tables.integration_connections[0].last_error).toMatch(/token_revoked/)
    for (const r of db.tables.integration_subscriptions) { expect(r.active).toBe(false); expect(r.disabled_reason).toMatch(/reconnected/i) }
  })
  it('a rejected message is dead but the rule stays on (our fault, not the channel\'s)', async () => {
    const db = slackWorld(); await run(db, answer({ ok: false, error: 'invalid_blocks' }))
    expect(d(db).status).toBe('dead'); expect(s(db).active).toBe(true)
  })
  it('skips without calling Slack when the connection needs reconnecting or is gone', async () => {
    const slack = answer({ ok: true })
    const db = slackWorld({ conn: { status: 'error' } }); await run(db, slack)
    expect(d(db).status).toBe('skipped'); expect(slack).not.toHaveBeenCalled()
  })
  it('a token that cannot be decrypted is dead and never sent anywhere', async () => {
    const slack = answer({ ok: true })
    const db = slackWorld({ conn: { credentials_enc: encryptSecret('{"access_token":"x"}', 'some-other-context') } }); await run(db, slack)
    expect(d(db).status).toBe('dead'); expect(slack).not.toHaveBeenCalled()
  })
  it('Slack needs the Pro plan: a Starter workspace is skipped, a trial is allowed', async () => {
    const slack = answer({ ok: true })
    const starter = slackWorld({ ws: { plan_tier: 'starter' } }); await run(starter, slack)
    expect(d(starter).status).toBe('skipped'); expect(slack).not.toHaveBeenCalled()
    const trial = slackWorld({ ws: { plan_tier: 'trial', trial_ends_at: '2027-01-01T00:00:00Z' } }); await run(trial, slack)
    expect(d(trial).status).toBe('succeeded')
  })
  it('after the last attempt it goes dead and counts toward the rule\'s auto-disable', async () => {
    const db = slackWorld({ attempts: 8 }); await run(db, answer({ ok: false, error: 'internal_error' }))
    expect(d(db).status).toBe('dead'); expect(s(db).consecutive_failures).toBe(1)
  })
})

describe('POST /slack/connect', () => {
  beforeEach(() => world())
  it('returns the authorize URL, bound to this workspace and person', async () => {
    const r = await connect(); expect(r.status).toBe(200)
    const u = new URL((await r.json()).url)
    expect(verifyState(u.searchParams.get('state'))).toEqual({ ok: true, state: { ws: WS, uid: USER } })
  })
  it('needs login, the permission, the Pro plan, a recent re-authentication and server config', async () => {
    h.session = null; expect((await connect()).status).toBe(401)
    h.session = { ...h.session, id: USER }; h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: [] }; expect((await connect()).status).toBe(403)
    h.session = { id: USER, workspaceId: WS, planTier: 'starter', permissions: ALL }; const r = await connect(); expect(r.status).toBe(402)
    h.session = { id: USER, workspaceId: WS, planTier: 'pro', permissions: ALL }
    const { NextResponse } = await import('next/server'); h.stepUp = NextResponse.json({ code: 'step_up_required' }, { status: 401 })
    expect((await connect()).status).toBe(401); h.stepUp = null
    delete process.env.SLACK_CLIENT_SECRET; expect((await connect()).status).toBe(503)
  })
})

describe('GET /slack/callback', () => {
  const state = () => signState({ ws: WS, uid: USER })
  const oauthOk = { ok: true, access_token: 'xoxb-new-token', token_type: 'bot', scope: 'chat:write', bot_user_id: 'UBOT', team: { id: 'T1', name: 'Acme' }, authed_user: { id: 'UHUMAN' } }
  const go = async (qs: string) => { const r = await callback(new NextRequest(`http://localhost/api/integrations/slack/callback?${qs}`)); return new URL(r.headers.get('location')!).searchParams.get('slack') }
  beforeEach(() => { world({ conn: null }); h.slack = async () => ({ status: 200, retryAfter: null, body: oauthOk }) })

  it('connects: stores the token ENCRYPTED, bound to the row, never in plaintext, and audits it', async () => {
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    const c = conns()[0]
    expect(c).toMatchObject({ workspace_id: WS, provider: 'slack', status: 'active', created_by: USER, config: { team_id: 'T1', team_name: 'Acme', bot_user_id: 'UBOT' } })
    expect(JSON.stringify(c)).not.toContain('xoxb-new-token')
    expect(JSON.parse(decryptSecret(c.credentials_enc, `${WS}:${c.id}`)).access_token).toBe('xoxb-new-token')
    expect(() => decryptSecret(c.credentials_enc, `${OTHER_WS}:${c.id}`)).toThrow()
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'workspace.slack_connected' })
    const [method, , payload, opts] = h.slackCalls[0]
    expect(method).toBe('oauth.v2.access'); expect(opts).toEqual({ form: true })
    expect(payload).toMatchObject({ code: 'abc', client_id: 'cid', redirect_uri: 'https://app.example.com/api/integrations/slack/callback' })
  })
  const OTHER_WS = '11111111-2222-4333-8444-555555555555'
  it('refuses a forged, expired or missing state without ever calling Slack', async () => {
    expect(await go('code=abc&state=garbage')).toBe('failed')
    expect(await go('code=abc')).toBe('failed')
    const old = signState({ ws: WS, uid: USER }, Date.now() - STATE_TTL_MS - 5000)
    expect(await go(`code=abc&state=${old}`)).toBe('expired')
    expect(h.slackCalls).toHaveLength(0); expect(conns()).toHaveLength(0)
  })
  it('refuses when the signed-in person or workspace is not the one who started it', async () => {
    h.session = { ...h.session, id: 'someone-else' }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = { ...h.session, id: USER, workspaceId: OTHER_WS }; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    h.session = null; expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    expect(h.slackCalls).toHaveLength(0); expect(conns()).toHaveLength(0)
  })
  it('refuses without the permission, on a lapsed workspace, or below Pro', async () => {
    h.session = { ...h.session, permissions: [] }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, permissions: ALL, lapsed: true }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    h.session = { ...h.session, lapsed: false, planTier: 'starter' }; expect(await go(`code=abc&state=${state()}`)).toBe('forbidden')
    expect(conns()).toHaveLength(0)
  })
  it('handles Cancel on the Slack page', async () => { expect(await go(`error=access_denied&state=${state()}`)).toBe('denied') })
  it('does not trust an OAuth answer that is not a bot token for a team', async () => {
    for (const body of [{ ok: false, error: 'invalid_code' }, { ...oauthOk, access_token: 'xoxp-user-token' }, { ...oauthOk, team: undefined }, null]) {
      h.slack = async () => ({ status: 200, retryAfter: null, body }); expect(await go(`code=abc&state=${state()}`)).toBe('failed')
    }
    expect(conns()).toHaveLength(0)
  })
  it('reconnecting the SAME Slack workspace revives the rules a dead token had switched off', async () => {
    world({ subs: [rule({ active: false, disabled_reason: 'Slack needs to be reconnected (token_revoked).', consecutive_failures: 10 }), rule({ id: 'manual', config: { channel_id: 'C9999999999' }, active: false, disabled_reason: 'Turned off after 10 deliveries in a row failed.' })], conn: { status: 'error', last_error: 'x' } })
    h.slack = async () => ({ status: 200, retryAfter: null, body: oauthOk })
    expect(await go(`code=abc&state=${state()}`)).toBe('connected')
    expect(conns()[0]).toMatchObject({ id: CONN, status: 'active', last_error: null })
    expect(subs().find((r: any) => r.id === RULE)).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0 })
    expect(subs().find((r: any) => r.id === 'manual').active).toBe(false) // only the reconnect-caused ones come back
    expect(conns()).toHaveLength(1)
  })
  it('connecting a DIFFERENT Slack workspace drops the old channel rules (their ids mean nothing there)', async () => {
    world({ subs: [rule()] }); h.slack = async () => ({ status: 200, retryAfter: null, body: { ...oauthOk, team: { id: 'T2', name: 'Other' } } })
    expect(await go(`code=abc&state=${state()}`)).toBe('connected'); expect(subs()).toHaveLength(0); expect(conns()[0].config.team_id).toBe('T2')
  })
})

describe('disconnect', () => {
  it('revokes at Slack, deletes the connection and its rules (cascade), and audits', async () => {
    world({ subs: [rule()] })
    const r = await disconnect(); expect(r.status).toBe(200)
    expect(h.slackCalls[0].slice(0, 2)).toEqual(['auth.revoke', 'xoxb-live-token']); expect(conns()).toHaveLength(0)
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'workspace.slack_disconnected' })
  })
  it('still disconnects when Slack is unreachable, on any plan, and is a no-op when not connected', async () => {
    world({ conn: undefined }); h.slack = async () => { throw new Error('down') }; h.session = { ...h.session, planTier: 'solo' }
    expect((await disconnect()).status).toBe(200); expect(conns()).toHaveLength(0)
    expect((await disconnect()).status).toBe(200)
  })
  it('requires the permission', async () => { world(); h.session = { ...h.session, permissions: [] }; expect((await disconnect()).status).toBe(403) })
})

describe('GET /slack/channels', () => {
  it('lists channels alphabetically across pages, public and invited-private', async () => {
    world(); let page = 0
    h.slack = async () => (page++ === 0
      ? { status: 200, retryAfter: null, body: { ok: true, channels: [{ id: 'C2', name: 'zeta' }, { id: 'G1', name: 'alpha', is_private: true, is_member: true }], response_metadata: { next_cursor: 'N' } } }
      : { status: 200, retryAfter: null, body: { ok: true, channels: [{ id: 'C3', name: 'beta', is_member: true }] } })
    const r = await listChannels(); const j = await r.json()
    expect(j.channels.map((c: any) => c.name)).toEqual(['alpha', 'beta', 'zeta']); expect(j.channels[0].is_private).toBe(true)
    expect(h.slackCalls[0][2]).toMatchObject({ types: 'public_channel,private_channel', exclude_archived: true })
  })
  it('a revoked token answers "reconnect" and flags the connection', async () => {
    world({ subs: [rule()] }); h.slack = async () => ({ status: 200, retryAfter: null, body: { ok: false, error: 'invalid_auth' } })
    const r = await listChannels(); expect(r.status).toBe(409); expect((await r.json()).reconnect).toBe(true)
    expect(conns()[0].status).toBe('error'); expect(subs()[0].active).toBe(false)
  })
  it('409 when not connected', async () => { world({ conn: null }); expect((await listChannels()).status).toBe(409) })
})

describe('POST /slack/rules', () => {
  const create = (body: unknown) => createRule(req('/api/workspace/integrations/slack/rules', { method: 'POST', body }))
  const info = (ch: any) => { h.slack = async () => ({ status: 200, retryAfter: null, body: { ok: true, channel: ch } }) }
  beforeEach(() => { world(); info({ id: 'C0123456789', name: 'general', is_private: false, is_member: false }) })

  it('creates a rule for a verified public channel (the name comes from Slack, not the browser)', async () => {
    const r = await create({ channel_id: 'C0123456789', events: ['sow.signed', 'invoice.paid'], channel_name: 'SPOOFED' }); expect(r.status).toBe(201)
    expect(subs()[0]).toMatchObject({ kind: 'slack', connection_id: CONN, name: '#general', secret_enc: null, event_types: ['sow.signed', 'invoice.paid'], config: { channel_id: 'C0123456789', channel_name: 'general', is_private: false } })
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'workspace.slack_rule_created' })
  })
  it('refuses an uninvited PRIVATE channel with the fix, and an archived one', async () => {
    info({ id: 'G0123456789', name: 'secret', is_private: true, is_member: false })
    const r = await create({ channel_id: 'G0123456789', events: ['sow.signed'] }); expect(r.status).toBe(400); expect((await r.json()).error).toMatch(/\/invite @ScopeGov/)
    info({ id: 'C0123456789', name: 'old', is_archived: true }); expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(400)
    expect(subs()).toHaveLength(0)
  })
  it('allows a private channel the app IS in', async () => {
    info({ id: 'G0123456789', name: 'secret', is_private: true, is_member: true })
    expect((await create({ channel_id: 'G0123456789', events: ['sow.signed'] })).status).toBe(201); expect(subs()[0].config.is_private).toBe(true)
  })
  it('validates input: channel id shape, events, unknown events', async () => {
    expect((await create({ channel_id: 'general', events: ['sow.signed'] })).status).toBe(400)
    expect((await create({ channel_id: 'C0123456789', events: [] })).status).toBe(400)
    expect((await create({ channel_id: 'C0123456789', events: ['nope.nope'] })).status).toBe(400)
    expect((await create(undefined)).status).toBe(400)
    expect(h.slackCalls).toHaveLength(0)
  })
  it('you can only route events you could see yourself', async () => {
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS', 'SEND_SOW'] }
    const r = await create({ channel_id: 'C0123456789', events: ['sow.signed', 'invoice.paid'] }); expect(r.status).toBe(403)
    expect((await r.json()).error).toMatch(/VIEW_FINANCIALS/); expect(subs()).toHaveLength(0)
  })
  it('one rule per channel (409), and a cap per workspace', async () => {
    expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(201)
    expect((await create({ channel_id: 'C0123456789', events: ['invoice.paid'] })).status).toBe(409)
    world({ subs: Array.from({ length: MAX_SLACK_RULES }, (_, i) => rule({ id: `r${i}`, config: { channel_id: `C00000000${i}0` } })) })
    info({ id: 'C0123456789', name: 'general' }); expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(409)
  })
  it('needs a connection, Pro, and a recent re-authentication', async () => {
    world({ conn: null }); expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(409)
    world(); h.session = { ...h.session, planTier: 'starter' }; expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(402)
    h.session = { ...h.session, planTier: 'pro' }; const { NextResponse } = await import('next/server'); h.stepUp = NextResponse.json({ code: 'step_up_required' }, { status: 401 })
    expect((await create({ channel_id: 'C0123456789', events: ['sow.signed'] })).status).toBe(401)
  })
})

describe('rule edit / delete / test, and the generic webhook routes leaving Slack alone', () => {
  beforeEach(() => world({ subs: [rule()] }))
  it('PATCH changes events (permission-checked) and toggles; turning on needs a live connection', async () => {
    expect((await patchRule(req('/x', { method: 'PATCH', body: { events: ['sow.signed', 'sow.declined'] } }), ctx(RULE))).status).toBe(200)
    expect(subs()[0].event_types).toEqual(['sow.signed', 'sow.declined'])
    h.session = { ...h.session, permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
    expect((await patchRule(req('/x', { method: 'PATCH', body: { events: ['sow.signed'] } }), ctx(RULE))).status).toBe(403)
    h.session = { ...h.session, permissions: ALL }
    world({ subs: [rule({ active: false, disabled_reason: 'x' })], conn: { status: 'error' } })
    expect((await patchRule(req('/x', { method: 'PATCH', body: { active: true } }), ctx(RULE))).status).toBe(409)
    world({ subs: [rule({ active: false, disabled_reason: 'x', consecutive_failures: 5 })] })
    expect((await patchRule(req('/x', { method: 'PATCH', body: { active: true } }), ctx(RULE))).status).toBe(200)
    expect(subs()[0]).toMatchObject({ active: true, disabled_reason: null, consecutive_failures: 0 })
  })
  it('PATCH / DELETE / test are scoped to this workspace\'s Slack rules', async () => {
    h.db.tables.integration_subscriptions.push({ id: '77777777-7777-4777-8777-777777777777', workspace_id: 'other', connection_id: 'oc', kind: 'slack', event_types: ['sow.signed'], active: true, config: { channel_id: 'C1' } })
    h.db.tables.integration_subscriptions.push({ id: '88888888-8888-4888-8888-888888888888', workspace_id: WS, kind: 'webhook', event_types: ['sow.signed'], active: true, secret_enc: 'x' })
    for (const id of ['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888']) {
      expect((await patchRule(req('/x', { method: 'PATCH', body: { active: false } }), ctx(id))).status).toBe(404)
      expect((await deleteRule(req('/x', { method: 'DELETE' }), ctx(id))).status).toBe(404)
      expect((await testRule(req('/x', { method: 'POST' }), ctx(id))).status).toBe(404)
    }
    expect(subs()).toHaveLength(3); expect((await patchRule(req('/x', { method: 'PATCH', body: { active: false } }), ctx('nope'))).status).toBe(404)
  })
  it('DELETE removes the rule and audits it', async () => {
    expect((await deleteRule(req('/x', { method: 'DELETE' }), ctx(RULE))).status).toBe(200); expect(subs()).toHaveLength(0)
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'workspace.slack_rule_deleted' })
  })
  it('test queues one test event for this rule only', async () => {
    h.db = createFakeSupabase({ integration_connections: [], integration_subscriptions: [rule()], audit_log: [] }, { rpc: { enqueue_integration_test: () => ({ data: 'ev' }) } })
    expect((await testRule(req('/x', { method: 'POST' }), ctx(RULE))).status).toBe(200)
    expect(h.db.rpcCalls[0]).toMatchObject({ name: 'enqueue_integration_test', args: { p_subscription_id: RULE, p_workspace_id: WS } })
  })
  it('the generic webhook routes can neither toggle nor delete a Slack rule', async () => {
    expect((await patchWebhook(req('/x', { method: 'PATCH', body: { active: false } }), ctx(RULE))).status).toBe(404)
    expect((await deleteWebhook(req('/x', { method: 'DELETE' }), ctx(RULE))).status).toBe(404)
    expect(subs()[0].active).toBe(true); expect(subs()).toHaveLength(1)
  })
})
