import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))

import { generateApiKey } from '@/lib/integrations/api-keys'
import { EVENT_CATALOG, sampleEnvelope } from '@/lib/integrations/event-catalog'
import { INTEGRATION_EVENT_TYPES, INTEGRATION_EVENT_MAP, permissionForEvent, eventsBeyondPermissions, emitIntegrationEvent } from '@/lib/integrations/events'
import { validateZapierTarget, keyCreatorHolds, ZAPIER_HOOK_HOST } from '@/lib/integrations/zapier'
import { buildEnvelope } from '@/lib/integrations/delivery'
import { POST as subscribe } from '@/app/api/integrations/v1/hooks/route'
import { DELETE as unsubscribe } from '@/app/api/integrations/v1/hooks/[id]/route'
import { GET as sample } from '@/app/api/integrations/v1/events/[type]/sample/route'
import { GET as me } from '@/app/api/integrations/v1/me/route'

const WS = '0f1e2d3c-4b5a-4968-8776-655443322110', OTHER_WS = '11111111-2222-4333-8444-555555555555', USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK = `https://${ZAPIER_HOOK_HOST}/hooks/standard/123/abc/`

const ALL = { SEND_SOW: true, SEND_CHANGE_ORDERS: true, APPROVE_FLAGS: true, VIEW_FINANCIALS: true }
function world(over: { perms?: any; plan?: string; member?: any; subs?: any[]; key?: any } = {}) {
  const k = generateApiKey()
  h.db = createFakeSupabase({
    integration_api_keys: [{ id: 'k1', workspace_id: WS, key_hash: k.hash, created_by: USER, expires_at: null, revoked_at: null, last_used_at: null, ...over.key }],
    workspaces: [{ id: WS, name: 'Acme Studio', agency_name: 'Acme Studio Ltd', plan_tier: over.plan ?? 'starter', trial_ends_at: null, lapsed_at: null, deleted_at: null }],
    workspace_members: [{ id: 'm1', workspace_id: WS, user_id: USER, status: 'active', effective_permissions: over.perms ?? ALL, ...over.member }],
    integration_subscriptions: over.subs ?? [],
    audit_log: [],
  })
  return k.key
}
const req = (key: string | null, url: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method || 'GET',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
const subs = () => h.db.tables.integration_subscriptions

beforeEach(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('event catalog', () => {
  it('describes exactly the events that can be subscribed to, once each', () => {
    expect(EVENT_CATALOG.map(e => e.type).sort()).toEqual([...INTEGRATION_EVENT_TYPES].sort())
  })
  it('samples have the exact shape of a real delivery (keys match buildEnvelope)', () => {
    const real = buildEnvelope({ id: 'e', event_type: 'x', created_at: 'n', workspace_id: 'w', project_id: 'p', entity_type: 'project', entity_id: 'p', data: {} }, { project: { id: 'p', name: 'n', status: 's' }, client: { id: 'c', name: 'n' } })
    for (const e of EVENT_CATALOG) expect(Object.keys(sampleEnvelope(e)).sort()).toEqual(Object.keys(real).sort())
  })
  it('the committed Zapier events.json is the generated one (run scripts/gen-zapier-events.mjs if this fails)', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'integrations', 'zapier', 'events.json'), 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(EVENT_CATALOG.map(e => ({ type: e.type, label: e.label, description: e.description, sample: sampleEnvelope(e) })))))
  })
})

describe('permission for an event follows the notification it mirrors', () => {
  it("equals the `permission:` at every real notifyMembersWithPermission call site (drift guard)", () => {
    const seen: Record<string, Set<string>> = {}
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : [])
    for (const f of [...walk(path.join(__dirname, '..', 'app')), ...walk(path.join(__dirname, '..', 'lib'))]) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(/notifyMembersWithPermission\(/g)) {
        const chunk = src.slice(m.index! + m[0].length, m.index! + m[0].length + 900)
        const e = /eventType:\s*'([a-z_]+)'/.exec(chunk), p = /permission:\s*'([A-Z_]+)'/.exec(chunk)
        if (e && p) (seen[e[1]] ||= new Set()).add(p[1])
      }
    }
    let checked = 0
    for (const [key, pub] of Object.entries(INTEGRATION_EVENT_MAP)) {
      expect(seen[key], `${key} has a call site`).toBeTruthy()
      expect([...seen[key]], key).toEqual([permissionForEvent(pub)])
      checked++
    }
    expect(checked).toBe(Object.keys(INTEGRATION_EVENT_MAP).length)
  })
  it('lists what a holder lacks', () => {
    expect(eventsBeyondPermissions(['sow.signed', 'invoice.paid'], p => p === 'SEND_SOW')).toEqual(['invoice.paid (VIEW_FINANCIALS)'])
    expect(eventsBeyondPermissions(['sow.signed'], () => true)).toEqual([])
  })
})

describe('de-duplication key (two different events on one project are not one event)', () => {
  const E = '22222222-2222-4222-8222-222222222222'
  it('differs when the announcement differs, and is identical when it is repeated', async () => {
    const db = createFakeSupabase({}, { rpc: { emit_integration_event: () => ({ data: 'id' }) } })
    const emit = (summary: string) => emitIntegrationEvent({ workspaceId: WS, eventKey: 'invoice_payment_received', entityType: 'project', entityId: E, data: { title: 'Payment received — X', summary } }, db.client)
    await emit('Acme paid $500'); await emit('Acme paid $300'); await emit('Acme paid $500')
    const keys = db.rpcCalls.map((c: any) => c.args.p_dedupe_key)
    expect(keys[0]).not.toBe(keys[1]); expect(keys[0]).toBe(keys[2])
    expect(db.rpcCalls[0].args.p_dedupe_minutes).toBe(10)
  })
})

describe('Zapier target URL', () => {
  it('accepts only an https hooks.zapier.com hook path', () => {
    expect(validateZapierTarget(HOOK)).toMatchObject({ ok: true })
    for (const bad of ['https://evil.example.com/hooks/x', 'http://hooks.zapier.com/hooks/x', 'https://hooks.zapier.com.evil.com/hooks/x', 'https://hooks.zapier.com:8443/hooks/x',
      'https://u:p@hooks.zapier.com/hooks/x', 'https://hooks.zapier.com/other', 'https://zapier.com/hooks/x', '', null, 42, 'x'.repeat(3000)])
      expect(validateZapierTarget(bad as any).ok, String(bad)).toBe(false)
  })
})

describe('GET /api/integrations/v1/me', () => {
  it('answers the workspace for a good key; every failure is the same bare 401', async () => {
    const key = world()
    const ok = await me(req(key, '/api/integrations/v1/me'))
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ workspace: { id: WS, name: 'Acme Studio Ltd' } })
    for (const bad of [null, 'sgk_' + 'A'.repeat(43), 'nonsense']) {
      const r = await me(req(bad, '/api/integrations/v1/me')); expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: 'Invalid API key' })
    }
  })
})

describe('POST /api/integrations/v1/hooks (Zapier subscribe)', () => {
  const sub = (key: string | null, body: unknown) => subscribe(req(key, '/api/integrations/v1/hooks', { method: 'POST', body }))
  it('creates a Zapier hook for one event; the secret is stored encrypted and never returned', async () => {
    const key = world()
    const r = await sub(key, { target_url: HOOK, event: 'invoice.paid' })
    expect(r.status).toBe(201)
    const { id, ...rest } = await r.json(); expect(rest).toEqual({}); expect(id).toBeTruthy()
    expect(subs()).toHaveLength(1)
    expect(subs()[0]).toMatchObject({ id, workspace_id: WS, kind: 'zapier', target_url: HOOK, event_types: ['invoice.paid'], name: 'Zapier · Invoice Paid' })
    expect(subs()[0].secret_enc).toMatch(/^v1\./)
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'workspace.zapier_hook_created', workspace_id: WS })
  })
  it('is idempotent on the target URL (a Zapier retry never doubles the events)', async () => {
    const key = world()
    const a = await (await sub(key, { target_url: HOOK, event: 'invoice.paid' })).json()
    const r2 = await sub(key, { target_url: HOOK, event: 'invoice.paid' })
    expect(r2.status).toBe(200); expect((await r2.json()).id).toBe(a.id); expect(subs()).toHaveLength(1)
  })
  it('re-subscribing revives a hook that had been switched off', async () => {
    const key = world({ subs: [{ id: 's1', workspace_id: WS, kind: 'zapier', target_url: new URL(HOOK).toString(), event_types: ['invoice.paid'], active: false, consecutive_failures: 10, disabled_reason: 'x' }] })
    const r = await sub(key, { target_url: HOOK, event: 'invoice.paid' })
    expect((await r.json()).id).toBe('s1'); expect(subs()[0]).toMatchObject({ active: true, consecutive_failures: 0, disabled_reason: null })
  })
  it('rejects: no key, a non-Zapier URL, an unknown event, a missing body', async () => {
    const key = world()
    expect((await sub(null, { target_url: HOOK, event: 'invoice.paid' })).status).toBe(401)
    expect((await sub(key, { target_url: 'https://evil.example.com/hooks/x', event: 'invoice.paid' })).status).toBe(400)
    expect((await sub(key, { target_url: HOOK, event: 'flag_comment_added' })).status).toBe(400)
    expect((await sub(key, undefined)).status).toBe(400)
    expect(subs()).toHaveLength(0)
  })
  it('refuses an event the key creator cannot see (no privilege bypass through a key)', async () => {
    const key = world({ perms: { SEND_SOW: true } })
    expect((await sub(key, { target_url: HOOK, event: 'sow.signed' })).status).toBe(201)
    const r = await sub(key, { target_url: HOOK + 'x/', event: 'invoice.paid' })
    expect(r.status).toBe(403); expect((await r.json()).error).toMatch(/VIEW_FINANCIALS/)
    expect(subs()).toHaveLength(1)
  })
  it('a key does not outlive its creator: removed or deactivated member => 403', async () => {
    expect((await sub(world({ member: { status: 'removed' } }), { target_url: HOOK, event: 'sow.signed' })).status).toBe(403)
    expect((await sub(world({ key: { created_by: null } }), { target_url: HOOK, event: 'sow.signed' })).status).toBe(403)
    expect(await keyCreatorHolds(h.db.client, WS, 'someone-else', 'SEND_SOW')).toBe(false)
  })
  it('plans below Starter and without a server key are refused', async () => {
    expect((await sub(world({ plan: 'solo' }), { target_url: HOOK, event: 'sow.signed' })).status).toBe(401)
    const key = world(); delete process.env.INTEGRATIONS_ENCRYPTION_KEY
    expect((await sub(key, { target_url: HOOK, event: 'sow.signed' })).status).toBe(503)
  })
  it('caps the number of Zap triggers per workspace', async () => {
    const key = world({ subs: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, workspace_id: WS, kind: 'zapier', target_url: `https://hooks.zapier.com/hooks/standard/${i}/`, event_types: ['sow.signed'], active: true })) })
    const r = await sub(key, { target_url: HOOK, event: 'sow.signed' })
    expect(r.status).toBe(409); expect(subs()).toHaveLength(100)
  })
  it('customer webhooks do not count against the Zapier cap (and vice versa)', async () => {
    const key = world({ subs: Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, workspace_id: WS, kind: 'webhook', target_url: `https://x${i}.example.com/`, event_types: ['sow.signed'], active: true })) })
    expect((await sub(key, { target_url: HOOK, event: 'sow.signed' })).status).toBe(201)
  })
})

describe('DELETE /api/integrations/v1/hooks/[id] (Zapier unsubscribe)', () => {
  const del = (key: string | null, id: string) => unsubscribe(req(key, `/api/integrations/v1/hooks/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
  const ID = '33333333-3333-4333-8333-333333333333'
  it('removes the hook, and is idempotent (200 even when already gone)', async () => {
    const key = world({ subs: [{ id: ID, workspace_id: WS, kind: 'zapier', target_url: HOOK, event_types: ['sow.signed'], active: true }] })
    expect((await del(key, ID)).status).toBe(200); expect(subs()).toHaveLength(0)
    expect((await del(key, ID)).status).toBe(200)
    expect((await del(key, 'not-a-uuid')).status).toBe(200)
  })
  it("never touches another workspace's hook, or a customer webhook, even with the id", async () => {
    const key = world({ subs: [
      { id: ID, workspace_id: OTHER_WS, kind: 'zapier', target_url: HOOK, event_types: ['sow.signed'], active: true },
      { id: '44444444-4444-4444-8444-444444444444', workspace_id: WS, kind: 'webhook', target_url: 'https://x.example.com/', event_types: ['sow.signed'], active: true },
    ] })
    await del(key, ID); await del(key, '44444444-4444-4444-8444-444444444444')
    expect(subs()).toHaveLength(2)
  })
  it('requires a valid key', async () => {
    world(); expect((await del(null, ID)).status).toBe(401)
  })
})

describe('GET /api/integrations/v1/events/[type]/sample', () => {
  const get = (key: string | null, type: string) => sample(req(key, `/api/integrations/v1/events/${type}/sample`), { params: Promise.resolve({ type }) })
  it('returns one example in delivery shape; 404 for an unknown event; 403 beyond the creator\'s permissions', async () => {
    const key = world({ perms: { SEND_SOW: true } })
    const ok = await get(key, 'sow.signed'); expect(ok.status).toBe(200)
    const body = await ok.json(); expect(Array.isArray(body)).toBe(true); expect(body[0]).toMatchObject({ type: 'sow.signed', project: { name: 'Website Redesign' } })
    expect((await get(key, 'nope.nope')).status).toBe(404)
    expect((await get(key, 'invoice.paid')).status).toBe(403)
    expect((await get(null, 'sow.signed')).status).toBe(401)
  })
})
