import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('not used in these tests') } }))

import { encryptSecret, decryptSecret, integrationCryptoConfigured, IntegrationCryptoError } from '@/lib/integrations/crypto'
import { integrationAllowed, INTEGRATION_MIN_PLAN } from '@/lib/integrations/plans'
import { signPayload, verifySignature, generateSigningSecret } from '@/lib/integrations/signing'
import { validateWebhookUrl } from '@/lib/integrations/url'
import { INTEGRATION_EVENT_MAP, INTEGRATION_EVENT_TYPES, emitIntegrationEvent } from '@/lib/integrations/events'
import { parseEventTypes } from '@/lib/integrations/event-input'
import { pickSafeAddress, pinnedLookup, pinnedPost, TimeoutError } from '@/lib/integrations/pinned-request'
import http from 'node:http'
import { classifyStatus, retryDelayMs, parseRetryAfter, processDeliveries, MAX_ATTEMPTS, AUTO_DISABLE_AFTER_DEAD, buildEnvelope } from '@/lib/integrations/delivery'
import { generateApiKey, hashApiKey, extractBearerKey, authenticateApiKey } from '@/lib/integrations/api-keys'
import { EMAIL_EVENT_TYPES } from '@/lib/constants/notification-events'

const KEY = randomBytes(32).toString('base64')
const KEY2 = randomBytes(32).toString('base64')
const env = (o: Record<string, string> = {}) => ({ INTEGRATIONS_ENCRYPTION_KEY: KEY, ...o }) as unknown as NodeJS.ProcessEnv

describe('integration crypto', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const a = encryptSecret('whsec_abc', 'ws:1', env()), b = encryptSecret('whsec_abc', 'ws:1', env())
    expect(a).not.toBe(b)
    expect(decryptSecret(a, 'ws:1', env())).toBe('whsec_abc')
    expect(a).not.toContain('whsec_abc')
  })
  it('refuses a ciphertext moved to another row or workspace (context is authenticated)', () => {
    const a = encryptSecret('s', 'ws:1', env())
    expect(() => decryptSecret(a, 'ws:2', env())).toThrow(IntegrationCryptoError)
  })
  it('detects tampering', () => {
    const parts = encryptSecret('secret-value', 'c', env()).split('.')
    parts[4] = Buffer.from('xxxxxxxxxxxx').toString('base64url')
    expect(() => decryptSecret(parts.join('.'), 'c', env())).toThrow(IntegrationCryptoError)
  })
  it('fails closed with no key, and rejects a key of the wrong length', () => {
    expect(integrationCryptoConfigured({} as any)).toBe(false)
    expect(() => encryptSecret('x', 'c', {} as any)).toThrow(/not configured/)
    expect(integrationCryptoConfigured({ INTEGRATIONS_ENCRYPTION_KEY: 'c2hvcnQ=' } as any)).toBe(false)
  })
  it('still decrypts old values during a key rotation, and refuses once the old key is dropped', () => {
    const old = encryptSecret('keep-me', 'c', env())
    const rotated = { INTEGRATIONS_ENCRYPTION_KEY: KEY2, INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS: KEY } as any
    expect(decryptSecret(old, 'c', rotated)).toBe('keep-me')
    expect(() => decryptSecret(old, 'c', { INTEGRATIONS_ENCRYPTION_KEY: KEY2 } as any)).toThrow(/No configured key/)
  })
})

describe('plan gate', () => {
  it('webhooks/zapier/api keys from Starter; native connectors from Pro; Solo none', () => {
    expect(integrationAllowed('webhook', 'solo')).toBe(false)
    expect(integrationAllowed('webhook', 'starter')).toBe(true)
    expect(integrationAllowed('api_keys', 'starter')).toBe(true)
    expect(integrationAllowed('slack', 'starter')).toBe(false)
    expect(integrationAllowed('slack', 'pro')).toBe(true)
    expect(integrationAllowed('hubspot', 'agency')).toBe(true)
    expect(integrationAllowed('google_drive', 'trial')).toBe(true)
  })
  it('a lapsed workspace gets nothing, whatever its tier', () => {
    expect(integrationAllowed('webhook', 'agency', true)).toBe(false)
  })
  it('covers every kind', () => {
    expect(Object.keys(INTEGRATION_MIN_PLAN).sort()).toEqual(['api_keys', 'google_drive', 'hubspot', 'slack', 'webhook', 'zapier'])
  })
})

describe('signing', () => {
  const secret = generateSigningSecret(), body = '{"a":1}', ts = '1800000000'
  const now = 1_800_000_000_000
  it('verifies a good signature and rejects tamper / wrong secret / stale / missing', () => {
    const sig = signPayload(secret, ts, body)
    expect(verifySignature(secret, ts, body, sig, 300, now)).toBe(true)
    expect(verifySignature(secret, ts, body + ' ', sig, 300, now)).toBe(false)
    expect(verifySignature('whsec_other', ts, body, sig, 300, now)).toBe(false)
    expect(verifySignature(secret, ts, body, sig, 300, now + 3_600_000)).toBe(false)
    expect(verifySignature(secret, null, body, sig, 300, now)).toBe(false)
    expect(verifySignature(secret, ts, body, null, 300, now)).toBe(false)
  })
  it('accepts any of several space-separated signatures (rotation)', () => {
    expect(verifySignature(secret, ts, body, `v1=deadbeef ${signPayload(secret, ts, body)}`, 300, now)).toBe(true)
  })
  it('secrets are prefixed and unique', () => {
    expect(generateSigningSecret()).toMatch(/^whsec_/)
    expect(generateSigningSecret()).not.toBe(generateSigningSecret())
  })
})

describe('webhook URL validation', () => {
  const prod = { NODE_ENV: 'production' } as any
  it('accepts a public https URL', () => { expect(validateWebhookUrl('https://hooks.example.com/x', prod)).toMatchObject({ ok: true }) })
  it.each([
    ['http://example.com/x', 'plain http in production'],
    ['https://user:pw@example.com/x', 'credentials in the URL'],
    ['https://localhost/x', 'localhost'],
    ['https://10.0.0.5/x', 'an IP literal'],
    ['https://[::1]/x', 'an IPv6 literal'],
    ['https://intranet/x', 'a single-label host'],
    ['https://db.internal/x', '.internal'],
    ['not a url', 'garbage'],
    ['', 'empty'],
  ])('rejects %s (%s)', (u) => { expect(validateWebhookUrl(u, prod).ok).toBe(false) })
  it('allows http only outside production', () => { expect(validateWebhookUrl('http://example.com/x', { NODE_ENV: 'development' } as any).ok).toBe(true) })
})

describe('event allowlist', () => {
  it('only maps events that really exist as notification events, so the two lists cannot drift', () => {
    for (const k of Object.keys(INTEGRATION_EVENT_MAP)) expect(EMAIL_EVENT_TYPES as readonly string[], k).toContain(k)
  })
  it('never exposes per-person or billing/security events', () => {
    for (const k of ['flag_comment_added', 'project_message_mention', 'member_joined', 'member_left', 'trial_ending', 'approval_requested']) expect(INTEGRATION_EVENT_MAP[k]).toBeUndefined()
  })
  it('external names are unique and dotted', () => {
    expect(new Set(INTEGRATION_EVENT_TYPES).size).toBe(INTEGRATION_EVENT_TYPES.length)
    for (const t of INTEGRATION_EVENT_TYPES) expect(t).toMatch(/^[a-z_]+\.[a-z_]+$/)
  })
  it('parseEventTypes validates, dedupes and rejects unknowns', () => {
    expect(parseEventTypes(['sow.signed', 'sow.signed'])).toEqual({ ok: true, types: ['sow.signed'] })
    expect(parseEventTypes([]).ok).toBe(false)
    expect(parseEventTypes(['nope.nope']).ok).toBe(false)
    expect(parseEventTypes('sow.signed').ok).toBe(false)
  })
})

describe('emitIntegrationEvent', () => {
  const WS = '11111111-1111-4111-8111-111111111111', EN = '22222222-2222-4222-8222-222222222222'
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  it('maps the notification key to the public name and passes ids through', async () => {
    const db = createFakeSupabase({}, { rpc: { emit_integration_event: () => ({ data: 'evt-1' }) } })
    expect(await emitIntegrationEvent({ workspaceId: WS, eventKey: 'sow_signed', entityType: 'sow', entityId: EN, data: { title: 't' } }, db.client)).toBe(true)
    expect(db.rpcCalls[0].args).toMatchObject({ p_workspace_id: WS, p_event_type: 'sow.signed', p_entity_id: EN, p_entity_type: 'sow' })
  })
  it('ignores events off the allowlist without touching the database', async () => {
    const db = createFakeSupabase()
    expect(await emitIntegrationEvent({ workspaceId: WS, eventKey: 'flag_comment_added' }, db.client)).toBe(false)
    expect(db.rpcCalls).toHaveLength(0)
  })
  it('nulls a non-uuid entity id instead of failing the insert', async () => {
    const db = createFakeSupabase({}, { rpc: { emit_integration_event: () => ({ data: null }) } })
    await emitIntegrationEvent({ workspaceId: WS, eventKey: 'invoice_sent', entityId: 'not-a-uuid' }, db.client)
    expect(db.rpcCalls[0].args.p_entity_id).toBeNull()
  })
  it('never throws: an RPC error or a thrown client both resolve false', async () => {
    const bad = createFakeSupabase({}, { rpc: { emit_integration_event: () => ({ error: { message: 'boom' } }) } })
    expect(await emitIntegrationEvent({ workspaceId: WS, eventKey: 'sow_signed' }, bad.client)).toBe(false)
    expect(await emitIntegrationEvent({ workspaceId: WS, eventKey: 'sow_signed' }, { rpc: () => { throw new Error('down') } })).toBe(false)
  })
})

describe('delivery policy', () => {
  it('classifies statuses', () => {
    expect(classifyStatus(200)).toBe('ok'); expect(classifyStatus(204)).toBe('ok')
    expect(classifyStatus(410)).toBe('gone')
    for (const s of [301, 302, 307, 308]) expect(classifyStatus(s)).toBe('permanent')
    for (const s of [400, 401, 404, 408, 429, 500, 503]) expect(classifyStatus(s)).toBe('retry')
  })
  it('backs off 1m, 5m, 15m, 1h, 3h, 6h, 12h and never shortens for Retry-After', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => retryDelayMs(n) / 60_000)).toEqual([1, 5, 15, 60, 180, 360, 720])
    expect(retryDelayMs(1, 600) / 60_000).toBe(10)
    expect(retryDelayMs(3, 30) / 60_000).toBe(15)
    expect(retryDelayMs(1, 10 * 86400) / 3_600_000).toBe(12)
  })
  it('parses Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('120')).toBe(120)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('garbage')).toBeNull()
    expect(parseRetryAfter(new Date(1_000_000 + 90_000).toUTCString(), 1_000_000)).toBeGreaterThanOrEqual(89)
  })
  it('envelope carries ids, type, and data', () => {
    expect(buildEnvelope({ id: 'e', event_type: 'sow.signed', created_at: 'now', workspace_id: 'w', project_id: 'p', entity_type: 'sow', entity_id: 's', data: { a: 1 } }))
      .toEqual({ id: 'e', type: 'sow.signed', created_at: 'now', workspace_id: 'w', project_id: 'p', entity: { type: 'sow', id: 's' }, project: null, client: null, data: { a: 1 } })
  })
  it('adds project and client NAMES (and nothing financial or personal) when it has them', () => {
    const env: any = buildEnvelope({ id: 'e', event_type: 'x', created_at: 'n', workspace_id: 'w', project_id: 'p', data: {} },
      { project: { id: 'p', name: 'Site', status: 'Active', contract_value: 99000, guardian_email: 'g@x.com', client_id: 'c' }, client: { id: 'c', name: 'Acme', email: 'a@acme.com', phone: '1' } })
    expect(env.project).toEqual({ id: 'p', name: 'Site', status: 'Active', currency: null })
    expect(env.client).toEqual({ id: 'c', name: 'Acme' })
    expect(JSON.stringify(env)).not.toMatch(/99000|@|phone/)
  })
  it('delivery payloads include project/client context looked up for the event', async () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY
    const sealed = encryptSecret('whsec_t', 'ws-1:sub-1')
    const db = createFakeSupabase({
      integration_deliveries: [{ id: 'd1', workspace_id: 'ws-1', subscription_id: 'sub-1', event_id: 'ev-1', attempts: 1, status: 'delivering' }],
      integration_subscriptions: [{ id: 'sub-1', workspace_id: 'ws-1', kind: 'webhook', target_url: 'https://h.example.com/x', secret_enc: sealed, active: true, consecutive_failures: 0 }],
      integration_events: [{ id: 'ev-1', workspace_id: 'ws-1', event_type: 'invoice.paid', entity_type: 'project', entity_id: 'p1', project_id: 'p1', data: { title: 'T' }, created_at: 'now' }],
      workspaces: [{ id: 'ws-1', plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null }],
      projects: [{ id: 'p1', name: 'Site', status: 'Active', client_id: 'c1', contract_value: 5000, clients: { id: 'c1', name: 'Acme', email: 'a@acme.com' } }],
    }, { rpc: { claim_integration_deliveries: () => ({ data: [{ id: 'd1', workspace_id: 'ws-1', subscription_id: 'sub-1', event_id: 'ev-1', attempts: 1 }] }) } })
    const send = vi.fn(async () => ({ status: 200, retryAfter: null }))
    await processDeliveries(db.client, { now: () => Date.now(), send })
    const sent = JSON.parse((send.mock.calls[0] as any)[1].body)
    expect(sent.project).toEqual({ id: 'p1', name: 'Site', status: 'Active', currency: null }); expect(sent.client).toEqual({ id: 'c1', name: 'Acme' })
    expect(JSON.stringify(sent)).not.toMatch(/5000|acme\.com/)
  })
})

describe('processDeliveries', () => {
  const WS = 'ws-1', SUB = 'sub-1', EV = 'ev-1'
  const NOW = Date.parse('2026-11-01T12:00:00Z')
  const baseEnv = process.env.INTEGRATIONS_ENCRYPTION_KEY
  let sealed: string
  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY
    sealed = encryptSecret('whsec_test', `${WS}:${SUB}`)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  const afterAll_ = () => { if (baseEnv === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY; else process.env.INTEGRATIONS_ENCRYPTION_KEY = baseEnv }

  function setup(over: { claimed?: any[]; sub?: any; ws?: any } = {}) {
    const claimed = over.claimed ?? [{ id: 'd1', workspace_id: WS, subscription_id: SUB, event_id: EV, attempts: 1 }]
    const db = createFakeSupabase({
      integration_deliveries: claimed.map(c => ({ ...c, status: 'delivering' })),
      integration_subscriptions: [{ id: SUB, workspace_id: WS, kind: 'webhook', target_url: 'https://hooks.example.com/x', secret_enc: sealed, active: true, consecutive_failures: 0, ...over.sub }],
      integration_events: [{ id: EV, workspace_id: WS, event_type: 'sow.signed', entity_type: 'sow', entity_id: 's', project_id: null, data: { title: 'Signed' }, created_at: '2026-11-01T11:59:00Z' }],
      workspaces: [{ id: WS, plan_tier: 'pro', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...over.ws }],
    }, { rpc: { claim_integration_deliveries: () => ({ data: claimed }) } })
    return db
  }
  const run = (db: any, send: any) => processDeliveries(db.client, { now: () => NOW, send })
  const delivery = (db: any) => db.tables.integration_deliveries[0]
  const sub = (db: any) => db.tables.integration_subscriptions[0]
  const ok = (status = 200, headers: Record<string, string> = {}) => vi.fn(async (_u: string, _r: any) => ({ status, retryAfter: headers['retry-after'] ?? null }))

  it('POSTs a signed envelope and marks the delivery succeeded', async () => {
    const db = setup(); const send = ok(200)
    const r = await run(db, send)
    expect(r).toMatchObject({ claimed: 1, succeeded: 1 })
    const [url, init] = send.mock.calls[0] as any
    expect(init.timeoutMs).toBe(8000)
    expect(url).toBe('https://hooks.example.com/x')
    const h = init.headers
    expect(h['X-ScopeGov-Event']).toBe('sow.signed'); expect(h['X-ScopeGov-Delivery']).toBe('d1')
    expect(verifySignature('whsec_test', h['X-ScopeGov-Timestamp'], init.body, h['X-ScopeGov-Signature'], 300, NOW)).toBe(true)
    expect(JSON.parse(init.body)).toMatchObject({ id: 'ev-1', type: 'sow.signed', data: { title: 'Signed' } })
    expect(delivery(db)).toMatchObject({ status: 'succeeded', last_status: 200 })
    expect(sub(db).last_success_at).toBeTruthy()
  })
  it('schedules a retry with backoff on a 500, honouring a longer Retry-After', async () => {
    const db = setup(); await run(db, ok(503, { 'retry-after': '600' }))
    expect(delivery(db)).toMatchObject({ status: 'pending', last_status: 503 })
    expect(Date.parse(delivery(db).next_attempt_at) - NOW).toBe(600_000)
  })
  it('retries a network error / timeout', async () => {
    const db = setup(); await run(db, vi.fn(async () => { throw new TimeoutError('timed out after 8s') }))
    expect(delivery(db)).toMatchObject({ status: 'pending' }); expect(delivery(db).last_error).toMatch(/timed out/)
  })
  it('goes dead after the last attempt and counts toward auto-disable', async () => {
    const db = setup({ claimed: [{ id: 'd1', workspace_id: WS, subscription_id: SUB, event_id: EV, attempts: MAX_ATTEMPTS }] })
    await run(db, ok(500))
    expect(delivery(db).status).toBe('dead'); expect(sub(db).consecutive_failures).toBe(1); expect(sub(db).active).toBe(true)
  })
  it(`switches the webhook off after ${AUTO_DISABLE_AFTER_DEAD} dead deliveries in a row`, async () => {
    const db = setup({ claimed: [{ id: 'd1', workspace_id: WS, subscription_id: SUB, event_id: EV, attempts: MAX_ATTEMPTS }], sub: { consecutive_failures: AUTO_DISABLE_AFTER_DEAD - 1 } })
    await run(db, ok(500))
    expect(sub(db).active).toBe(false); expect(sub(db).disabled_reason).toMatch(/in a row/)
  })
  it('410 Gone kills the delivery and turns the webhook off immediately', async () => {
    const db = setup(); await run(db, ok(410))
    expect(delivery(db).status).toBe('dead'); expect(sub(db).active).toBe(false); expect(sub(db).disabled_reason).toMatch(/410/)
  })
  it('a redirect is permanent: dead at once (no 8 pointless retries), counted, hint to fix the URL', async () => {
    const db = setup(); await run(db, ok(301))
    expect(delivery(db)).toMatchObject({ status: 'dead', last_status: 301 }); expect(delivery(db).last_error).toMatch(/redirect/)
    expect(sub(db).consecutive_failures).toBe(1); expect(sub(db).active).toBe(true)
  })
  it('a success resets the failure streak', async () => {
    const db = setup({ sub: { consecutive_failures: 4 } }); await run(db, ok(200))
    expect(sub(db).consecutive_failures).toBe(0)
  })
  it('skips (without sending) when the webhook is off, the workspace is deleted, lapsed, or on a plan without it', async () => {
    for (const over of [{ sub: { active: false } }, { ws: { deleted_at: '2026-10-01' } }, { ws: { lapsed_at: '2026-10-01' } }, { ws: { plan_tier: 'solo' } }]) {
      const db = setup(over as any), send = ok(200)
      const r = await run(db, send)
      expect(send).not.toHaveBeenCalled(); expect(r.skipped).toBe(1); expect(delivery(db).status).toBe('skipped')
    }
  })
  it('an unreadable signing secret is dead, not retried, and is never sent unsigned', async () => {
    const db = setup({ sub: { secret_enc: encryptSecret('x', 'some-other-row') } }), send = ok(200)
    await run(db, send)
    expect(send).not.toHaveBeenCalled(); expect(delivery(db)).toMatchObject({ status: 'dead' })
  })
  it('does not overwrite a delivery another worker has since reclaimed', async () => {
    const db = setup(); db.tables.integration_deliveries[0].attempts = 2 // a second worker took it over
    await run(db, ok(200))
    expect(delivery(db).status).toBe('delivering')
  })
  it('an empty queue is a no-op; a claim error surfaces', async () => {
    const empty = createFakeSupabase({}, { rpc: { claim_integration_deliveries: () => ({ data: [] }) } })
    expect(await processDeliveries(empty.client)).toMatchObject({ claimed: 0 })
    const bad = createFakeSupabase({}, { rpc: { claim_integration_deliveries: () => ({ error: { message: 'down' } }) } })
    await expect(processDeliveries(bad.client)).rejects.toThrow(/claim failed/)
    afterAll_()
  })
})

describe('API keys', () => {
  it('generates sgk_ keys, stores only a hash, and extracts only well-formed bearer tokens', () => {
    const k = generateApiKey()
    expect(k.key).toMatch(/^sgk_[A-Za-z0-9_-]{43}$/)
    expect(k.hash).toBe(hashApiKey(k.key)); expect(k.hash).not.toContain(k.key)
    expect(k.prefix).toBe(k.key.slice(0, 10))
    expect(extractBearerKey(`Bearer ${k.key}`)).toBe(k.key)
    for (const bad of [null, '', k.key, `Basic ${k.key}`, 'Bearer sgk_short', `Bearer ${k.key}x`]) expect(extractBearerKey(bad as any)).toBeNull()
  })
  const NOW = Date.parse('2026-11-01T12:00:00Z')
  const mk = (row: any, ws: any = {}) => {
    const k = generateApiKey()
    const db = createFakeSupabase({
      integration_api_keys: [{ id: 'k1', workspace_id: 'w1', key_hash: k.hash, expires_at: null, revoked_at: null, last_used_at: null, ...row }],
      workspaces: [{ id: 'w1', plan_tier: 'starter', trial_ends_at: null, lapsed_at: null, deleted_at: null, ...ws }],
    })
    return { k, db }
  }
  it('authenticates a live key and stamps last_used_at', async () => {
    const { k, db } = mk({})
    expect(await authenticateApiKey(db.client, `Bearer ${k.key}`, NOW)).toEqual({ workspaceId: 'w1', keyId: 'k1', createdBy: null })
    expect(db.tables.integration_api_keys[0].last_used_at).toBeTruthy()
  })
  it('refuses unknown, revoked, expired keys and ineligible workspaces', async () => {
    expect(await authenticateApiKey(mk({}).db.client, `Bearer ${generateApiKey().key}`, NOW)).toBeNull()
    for (const [row, ws] of [[{ revoked_at: '2026-10-01' }, {}], [{ expires_at: '2026-10-01T00:00:00Z' }, {}], [{}, { plan_tier: 'solo' }], [{}, { lapsed_at: '2026-10-01' }], [{}, { deleted_at: '2026-10-01' }]] as any[]) {
      const { k, db } = mk(row, ws)
      expect(await authenticateApiKey(db.client, `Bearer ${k.key}`, NOW)).toBeNull()
    }
  })
})

describe('pinned outbound requests (SSRF: rebinding + multi-record)', () => {
  const PUBLIC = '93.184.216.34'
  it('refuses when ANY resolved address is private, even if the first is public (multi-A bypass of the old check)', async () => {
    const lookupAll = async () => [{ address: PUBLIC, family: 4 }, { address: '10.0.0.5', family: 4 }]
    await expect(pickSafeAddress('evil.example.com', { lookupAll })).rejects.toThrow(/internal\/reserved address: 10\.0\.0\.5/)
    const meta = async () => [{ address: PUBLIC, family: 4 }, { address: '169.254.169.254', family: 4 }]
    await expect(pickSafeAddress('evil.example.com', { lookupAll: meta })).rejects.toThrow()
    const v6 = async () => [{ address: '::ffff:127.0.0.1', family: 6 }]
    await expect(pickSafeAddress('evil.example.com', { lookupAll: v6 })).rejects.toThrow()
  })
  it('returns the first address when all are public; refuses an IP literal that is private; fails when nothing resolves', async () => {
    expect(await pickSafeAddress('ok.example.com', { lookupAll: async () => [{ address: PUBLIC, family: 4 }] })).toEqual({ address: PUBLIC, family: 4 })
    await expect(pickSafeAddress('127.0.0.1')).rejects.toThrow(/internal\/reserved/)
    await expect(pickSafeAddress('[::1]')).rejects.toThrow(/internal\/reserved/)
    await expect(pickSafeAddress('none.example.com', { lookupAll: async () => [] })).rejects.toThrow(/Could not resolve/)
  })
  it('the pinned lookup answers with the validated address in both shapes Node asks for', () => {
    const l = pinnedLookup(PUBLIC, 4)
    l('whatever.example.com', { all: true }, (e: any, a: any) => expect(a).toEqual([{ address: PUBLIC, family: 4 }]))
    l('whatever.example.com', {}, (e: any, a: any, f: any) => { expect(a).toBe(PUBLIC); expect(f).toBe(4) })
    ;(l as any)('whatever.example.com', (e: any, a: any) => expect(a).toBe(PUBLIC))
  })

  // A real connection. The hostname does not resolve anywhere; the request can only succeed by going to the pinned address.
  describe('over a real socket', () => {
    let server: http.Server, port: number, seen: { host?: string; sig?: string; body: string; method?: string }[] = []
    let respond: (res: http.ServerResponse) => void
    beforeEach(async () => {
      seen = []; respond = res => { res.statusCode = 200; res.end('ignored body') }
      server = http.createServer((req, res) => {
        let body = ''; req.on('data', c => (body += c)); req.on('end', () => { seen.push({ host: req.headers.host, sig: String(req.headers['x-test'] ?? ''), body, method: req.method }); respond(res) })
      })
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port
    })
    const stop = () => new Promise<void>(r => { (server as any).closeAllConnections?.(); server.close(() => r()) })
    const deps = { lookupAll: async () => [{ address: '127.0.0.1', family: 4 }], isBlocked: () => false }
    const req = { headers: { 'Content-Type': 'application/json', 'X-Test': 'sig-1' }, body: '{"hello":"world"}', timeoutMs: 2000 }

    it('connects to the pinned IP (not by resolving the name), keeps the real Host, sends body + headers', async () => {
      const r = await pinnedPost(`http://hook.invalid:${port}/path?x=1`, req, deps, { NODE_ENV: 'test' } as any)
      expect(r).toEqual({ status: 200, retryAfter: null })
      expect(seen).toEqual([{ host: `hook.invalid:${port}`, sig: 'sig-1', body: '{"hello":"world"}', method: 'POST' }])
      await stop()
    })
    it('reports the status and Retry-After, and does NOT follow a redirect', async () => {
      respond = res => { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/latest/meta-data'); res.setHeader('Retry-After', '30'); res.end() }
      const r = await pinnedPost(`http://hook.invalid:${port}/`, req, deps, { NODE_ENV: 'test' } as any)
      expect(r).toEqual({ status: 302, retryAfter: '30' })
      expect(seen).toHaveLength(1)
      await stop()
    })
    it('times out a receiver that never answers', async () => {
      respond = () => { /* hang */ }
      await expect(pinnedPost(`http://hook.invalid:${port}/`, { ...req, timeoutMs: 150 }, deps, { NODE_ENV: 'test' } as any)).rejects.toBeInstanceOf(TimeoutError)
      await stop()
    })
    it('refuses without connecting when the real check sees a private address', async () => {
      await expect(pinnedPost(`http://hook.invalid:${port}/`, req, { lookupAll: deps.lookupAll }, { NODE_ENV: 'test' } as any)).rejects.toThrow(/internal\/reserved/)
      expect(seen).toHaveLength(0)
      await stop()
    })
    it('blocks plain http in production, and credentials in the URL', async () => {
      await expect(pinnedPost(`http://hook.invalid:${port}/`, req, deps, { NODE_ENV: 'production' } as any)).rejects.toThrow(/Blocked protocol/)
      await expect(pinnedPost(`http://u:p@hook.invalid:${port}/`, req, deps, { NODE_ENV: 'test' } as any)).rejects.toThrow(/Credentials/)
      expect(seen).toHaveLength(0)
      await stop()
    })
  })
})
