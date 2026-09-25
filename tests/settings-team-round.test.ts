// tests/settings-team-round.test.ts
//
// Regression tests for the Settings & Team fix round (migration 076): billing defaults, document
// numbering, the settings compare-and-swap write, unchanged-permission role edits, invite re-attribution,
// invite links, and lapsed-invite handling. Same call-aware fake Supabase pattern as
// tests/settings-team-repass-2.test.ts: the real route handlers run against a recording fake client.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
const rpcCalls: Array<{ name: string; args: any }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let rpcResolver: (name: string, args: any) => any = () => ({ data: [], error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          calls.push({ table, ops })
          return Promise.resolve(resolver(table, ops)).then(res, rej)
        }
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}
const first = (ops: Op[]) => ops[0]?.name
const arg = (ops: Op[], n: string) => ops.find(o => o.name === n)?.args
const updatesTo = (table: string) => calls.filter(c => c.table === table && first(c.ops) === 'update').map(c => arg(c.ops, 'update')![0])

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return rpcResolver(name, args) },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', async () => {
  const actual: any = await vi.importActual('@/lib/utils/notify')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => undefined]))
})
vi.mock('@/lib/utils/rate-limit', () => ({ checkInviteRateLimit: async () => ({ allowed: true }) }))
vi.mock('@/lib/utils/seat-limit', () => ({ checkSeatLimit: async () => ({ ok: true }) }))

const ALL = [
  'VIEW_OWN_PROJECTS', 'VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS', 'VIEW_CLIENT_DATA', 'CREATE_PROJECTS', 'EDIT_SOW', 'SEND_SOW',
  'CREATE_CHANGE_ORDERS', 'SEND_CHANGE_ORDERS', 'APPROVE_FLAGS', 'GRANT_EXCEPTIONS', 'MARK_DELIVERABLE_STATUS',
  'MARK_PAYMENT_MILESTONES', 'MARK_PROJECT_COMPLETE', 'ASSIGN_TEAM_MEMBERS', 'SUBMIT_GUARDIAN_CHECKS', 'ACCESS_GUARDIAN_HISTORY',
  'INVITE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_BILLING', 'DELETE_PROJECTS', 'VIEW_AUDIT_LOG', 'MANAGE_WORKSPACE_SETTINGS',
  'SEND_INVOICES', 'APPROVE_DOCUMENTS', 'VIEW_PORTFOLIO',
]
const allMap = (except: string[] = []) => Object.fromEntries(ALL.map(p => [p, !except.includes(p)]))
const mkSession = (permissions: string[], extra: any = {}) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com', agencyName: 'Acme', workspaceName: 'Acme', planTier: 'agency', permissions, ...extra,
})
const req = (url: string, method: string, body?: any) =>
  new NextRequest('http://localhost' + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const P = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  calls.length = 0; rpcCalls.length = 0
  resolver = () => ({ data: null, error: null })
  rpcResolver = () => ({ data: [], error: null })
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
})

// ═════════════════════════════════════════════════════════════════════════
// Settings PATCH: billing defaults, normalised values, compare-and-swap
// ═════════════════════════════════════════════════════════════════════════
const WS_ROW = {
  name: 'Acme', slug: 'acme', slug_changed_at: null, agency_name: 'Acme', industry: 'Other', currency: 'USD', timezone: 'Africa/Nairobi',
  sow_language: 'en', governing_law: 'Kenya', guardian_sensitivity_tier: 'medium', proactive_risk_alerts_enabled: true,
  proactive_risk_threshold: 10000, auto_client_reminders: false, client_reminder_after_days: 3, client_reminder_max: 3,
  tax_id: null, phone: null, website: null, default_payment_instructions: null, reply_to_email: null, legal_address: null,
  default_tax_rate: 0, default_tax_inclusive: true, default_payment_terms_days: null,
  updated_at: '2026-09-25T10:00:00.123+00:00',
}
function settingsResolver(updateResult: any = { data: [{ id: 'w1' }], error: null }) {
  resolver = (t, ops) => {
    if (t === 'workspaces' && first(ops) === 'select') return { data: WS_ROW, error: null }
    if (t === 'workspaces' && first(ops) === 'update') return updateResult
    return { data: null, error: null }
  }
}

describe('PATCH /api/workspace/settings — billing defaults', () => {
  it('rejects a tax rate over 100 and a negative one', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    expect((await PATCH(req('/api/workspace/settings', 'PATCH', { defaultTaxRate: 101 }))).status).toBe(400)
    expect((await PATCH(req('/api/workspace/settings', 'PATCH', { defaultTaxRate: -1 }))).status).toBe(400)
    expect((await PATCH(req('/api/workspace/settings', 'PATCH', { defaultTaxRate: '' }))).status).toBe(400)
  })
  it('stores the tax rate rounded to 2 decimals, and hands the stored value back', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { defaultTaxRate: '16.256', defaultTaxInclusive: false }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.values.defaultTaxRate).toBe(16.26)
    const w = updatesTo('workspaces')[0]
    expect(w.default_tax_rate).toBe(16.26)
    expect(w.default_tax_inclusive).toBe(false)
  })
  it('validates payment terms (whole days 0-365) and treats blank as "no default"', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    expect((await PATCH(req('/api/workspace/settings', 'PATCH', { defaultPaymentTermsDays: 366 }))).status).toBe(400)
    expect((await PATCH(req('/api/workspace/settings', 'PATCH', { defaultPaymentTermsDays: 7.5 }))).status).toBe(400)
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { defaultPaymentTermsDays: '14' }))
    expect(res.status).toBe(200)
    expect(updatesTo('workspaces').at(-1).default_payment_terms_days).toBe(14)
  })
})

describe('PATCH /api/workspace/settings — normalised values and the compare-and-swap write', () => {
  it('returns the value as the server stored it (whitespace collapsed), so the editor can re-baseline on it', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { name: 'Acme   Studio' }))
    expect(res.status).toBe(200)
    expect((await res.json()).values.name).toBe('Acme Studio')
  })
  it('writes conditionally on the updated_at it read', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    await PATCH(req('/api/workspace/settings', 'PATCH', { website: 'acme.com' }))
    const upd = calls.find(c => c.table === 'workspaces' && first(c.ops) === 'update')!
    const eqs = upd.ops.filter(o => o.name === 'eq').map(o => o.args)
    expect(eqs).toContainEqual(['updated_at', '2026-09-25T10:00:00.123+00:00'])
  })
  it('409s (with the reload prompt) when another writer got in between the read and the write', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver({ data: [], error: null })
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { website: 'acme.com' }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(Array.isArray(json.conflicts)).toBe(true) // the client shows "Reload latest settings" off this
  })
})

// ═════════════════════════════════════════════════════════════════════════
// FEATURE (deep audit, Settings independent re-pass — feature gap):
// workspaces.slug/slug_changed_at existed since migration 001 but were
// never editable or read back anywhere. PATCH /api/workspace/settings now
// accepts `slug`, validates its format, rate-limits changes by
// slug_changed_at, and surfaces a friendly conflict on the DB's own
// uniqueness constraint.
// ═════════════════════════════════════════════════════════════════════════
describe('PATCH /api/workspace/settings — workspace handle (slug)', () => {
  it('rejects an invalid handle (uppercase, too short, leading hyphen, bad characters) without writing', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    for (const bad of ['AB', 'ac', '-acme', 'acme_studio', 'acme studio', 'a'.repeat(51)]) {
      const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: bad }))
      expect(res.status).toBe(400)
    }
    expect(updatesTo('workspaces')).toHaveLength(0)
  })
  it('lower-cases a valid handle and writes slug_changed_at alongside it', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS']); settingsResolver()
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: 'Acme-Studio' }))
    expect(res.status).toBe(200)
    expect((await res.json()).values.slug).toBe('acme-studio')
    const update = updatesTo('workspaces')[0]
    expect(update.slug).toBe('acme-studio')
    expect(typeof update.slug_changed_at).toBe('string')
  })
  it('blocks a second change inside the 30-day cooldown with the next-eligible date', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'workspaces' && first(ops) === 'select')
        return { data: { ...WS_ROW, slug: 'acme', slug_changed_at: new Date().toISOString() }, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: 'acme-2' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('30 days')
    expect(updatesTo('workspaces')).toHaveLength(0)
  })
  it('allows changing it again once the cooldown has passed', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    resolver = (t, ops) => {
      if (t === 'workspaces' && first(ops) === 'select')
        return { data: { ...WS_ROW, slug: 'acme', slug_changed_at: old }, error: null }
      if (t === 'workspaces' && first(ops) === 'update') return { data: [{ id: 'w1' }], error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: 'acme-2' }))
    expect(res.status).toBe(200)
  })
  it('a slug unchanged from its current value never triggers the cooldown check, even if slug_changed_at is recent', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'workspaces' && first(ops) === 'select')
        return { data: { ...WS_ROW, slug: 'acme', slug_changed_at: new Date().toISOString() }, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: 'acme' }))
    expect(res.status).toBe(200)
    expect((await res.json()).unchanged).toBe(true)
  })
  it('turns a unique-constraint violation into a friendly "already taken" 409, not a generic 500', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'workspaces' && first(ops) === 'select') return { data: WS_ROW, error: null }
      if (t === 'workspaces' && first(ops) === 'update') return { data: null, error: { code: '23505', message: 'duplicate key' } }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', { slug: 'taken-handle' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('already taken')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Roles: an unchanged permission map is not a permission change
// ═════════════════════════════════════════════════════════════════════════
describe('PATCH /api/team/roles/[id] — rename without touching permissions', () => {
  it('lets a peer admin rename the role the OWNER holds when the permission map is unchanged (form always sends it)', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return ops.some(o => o.name === 'maybeSingle') ? { data: { name: 'Owner', description: null, permissions: allMap(), is_default: false }, error: null } : { data: [], error: null }
      if (t === 'workspaces' && first(ops) === 'select') return { data: { created_by: 'owner-user' }, error: null }
      if (t === 'workspace_members') return { data: { id: 'm-owner' }, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r-owner', 'PATCH', { name: 'Principal', permissions: allMap() }), P('r-owner'))
    expect(res.status).toBe(200)
    expect(rpcCalls.find(c => c.name === 'update_role_permissions_atomic')).toBeUndefined()
  })
  it('still refuses when the permission map actually changes', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return ops.some(o => o.name === 'maybeSingle') ? { data: { name: 'Owner', description: null, permissions: allMap(), is_default: false }, error: null } : { data: [], error: null }
      if (t === 'workspaces' && first(ops) === 'select') return { data: { created_by: 'owner-user' }, error: null }
      if (t === 'workspace_members') return { data: { id: 'm-owner' }, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r-owner', 'PATCH', { name: 'Principal', permissions: allMap(['VIEW_PORTFOLIO']) }), P('r-owner'))
    expect(res.status).toBe(403)
  })
  it('answers a request that changes nothing at all with unchanged, not "Nothing to update"', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return { data: { name: 'Finance', description: null, permissions: allMap(), is_default: false }, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r1', 'PATCH', { permissions: allMap() }), P('r1'))
    expect(res.status).toBe(200)
    expect((await res.json()).unchanged).toBe(true)
  })
})

describe('POST /api/team/roles — malformed body', () => {
  it('400s instead of throwing a 500', async () => {
    session = mkSession(['MANAGE_ROLES'])
    const { POST } = await import('@/app/api/team/roles/route')
    const r = new NextRequest('http://localhost/api/team/roles', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
    expect((await POST(r)).status).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Team PATCH: changing the role of a pending invite re-attributes it
// ═════════════════════════════════════════════════════════════════════════
function pendingInviteResolver() {
  resolver = (t, ops) => {
    if (t === 'workspace_members' && first(ops) === 'select')
      return { data: { user_id: null, role_id: 'r-old', status: 'invited', permission_overrides: null, effective_permissions: {}, users: null }, error: null }
    if (t === 'roles' && first(ops) === 'select') return { data: { id: 'r-new', name: 'Manager', permissions: allMap(['MANAGE_BILLING', 'INVITE_MEMBERS']) }, error: null }
    if (t === 'workspace_members' && first(ops) === 'update') return { data: null, error: null }
    return { data: null, error: null }
  }
}
describe('PATCH /api/team/[id] — role change on a pending invite', () => {
  it('needs INVITE_MEMBERS as well, because the changer becomes the inviter of record', async () => {
    session = mkSession(['MANAGE_ROLES', ...ALL.filter(p => p !== 'INVITE_MEMBERS' && p !== 'MANAGE_ROLES')])
    pendingInviteResolver()
    const { PATCH } = await import('@/app/api/team/[id]/route')
    const res = await PATCH(req('/api/team/m1', 'PATCH', { roleId: 'r-new' }), P('m1'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/INVITE_MEMBERS/)
    expect(rpcCalls.find(c => c.name === 'update_member_permissions_atomic')).toBeUndefined()
  })
  it('re-attributes invited_by to the person who made the change', async () => {
    session = mkSession(ALL)
    pendingInviteResolver()
    const { PATCH } = await import('@/app/api/team/[id]/route')
    const res = await PATCH(req('/api/team/m1', 'PATCH', { roleId: 'r-new' }), P('m1'))
    expect(res.status).toBe(200)
    expect(updatesTo('workspace_members')).toContainEqual({ invited_by: 'actor' })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Revoking a pending invite honours the role ceiling
// ═════════════════════════════════════════════════════════════════════════
describe('DELETE /api/team/[id] — revoking an invite into a role above your own', () => {
  it('403s', async () => {
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select')
        return { data: { id: 'm1', user_id: null, role_id: 'r-admin', status: 'invited', invited_email: 'a@x.com', effective_permissions: {}, users: null }, error: null }
      if (t === 'roles' && first(ops) === 'select') return { data: { permissions: allMap() }, error: null }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/team/[id]/route')
    const res = await DELETE(req('/api/team/m1', 'DELETE'), P('m1'))
    expect(res.status).toBe(403)
    expect(calls.find(c => c.table === 'workspace_members' && first(c.ops) === 'delete')).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Copy invite link
// ═════════════════════════════════════════════════════════════════════════
describe('POST /api/team/[id]/link', () => {
  const live = { id: 'm1', status: 'invited', invited_email: 'new@x.com', invite_token: 'LIVE-TOKEN', invite_token_expires_at: '2999-01-01T00:00:00Z', roles: null, users: null }
  it('needs INVITE_MEMBERS', async () => {
    session = mkSession(['MANAGE_ROLES'])
    const { POST } = await import('@/app/api/team/[id]/link/route')
    expect((await POST(req('/api/team/m1/link', 'POST'), P('m1'))).status).toBe(403)
  })
  it('returns the EXISTING link of a live invite without rotating anything', async () => {
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => (t === 'workspace_members' && first(ops) === 'select') ? { data: live, error: null } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/[id]/link/route')
    const res = await POST(req('/api/team/m1/link', 'POST'), P('m1'))
    const json = await res.json()
    expect(json.inviteUrl).toBe('https://app.test/invite/LIVE-TOKEN')
    expect(json.reissued).toBe(false)
    expect(updatesTo('workspace_members')).toHaveLength(0)
  })
  it('re-issues an expired invite (new token, this person becomes the inviter)', async () => {
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => (t === 'workspace_members' && first(ops) === 'select')
      ? { data: { ...live, status: 'expired', invite_token_expires_at: '2020-01-01T00:00:00Z' }, error: null }
      : { data: null, error: null }
    const { POST } = await import('@/app/api/team/[id]/link/route')
    const res = await POST(req('/api/team/m1/link', 'POST'), P('m1'))
    const json = await res.json()
    expect(json.reissued).toBe(true)
    const upd = updatesTo('workspace_members')[0]
    expect(upd.status).toBe('invited')
    expect(upd.invited_by).toBe('actor')
    expect(upd.invite_token).not.toBe('LIVE-TOKEN')
    expect(json.inviteUrl).toBe(`https://app.test/invite/${upd.invite_token}`)
  })
  it('treats an invite past its expiry as expired even if the cron has not flipped the status yet', async () => {
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => (t === 'workspace_members' && first(ops) === 'select')
      ? { data: { ...live, invite_token_expires_at: '2020-01-01T00:00:00Z' }, error: null }
      : { data: null, error: null }
    const { POST } = await import('@/app/api/team/[id]/link/route')
    const json = await (await POST(req('/api/team/m1/link', 'POST'), P('m1'))).json()
    expect(json.reissued).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Resend: honest message about the previous link
// ═════════════════════════════════════════════════════════════════════════
describe('POST /api/team/[id]/resend — failed send on an expired invite', () => {
  it('does not claim the old link still works', async () => {
    process.env.RESEND_API_KEY = 're_test'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'nope' }), { status: 422 })) as any
    try {
      session = mkSession(['INVITE_MEMBERS'])
      resolver = (t, ops) => {
        if (t === 'workspace_members' && first(ops) === 'select')
          return { data: { id: 'm1', status: 'expired', invited_email: 'new@x.com', user_id: null, invited_by: 'u9', invite_token: 'OLD', invite_token_expires_at: '2020-01-01T00:00:00Z', roles: null, users: null }, error: null }
        if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
        return { data: null, error: null }
      }
      const { POST } = await import('@/app/api/team/[id]/resend/route')
      const json = await (await POST(req('/api/team/m1/resend', 'POST'), P('m1'))).json()
      expect(json.emailFailed).toBe(true)
      expect(json.previousLinkStillWorks).toBe(false)
    } finally { globalThis.fetch = realFetch }
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Invite POST: a lapsed-but-unswept invite must not block a fresh one
// ═════════════════════════════════════════════════════════════════════════
describe('POST /api/team/invite — an invite past its expiry', () => {
  function inviteResolver(existing: any[]) {
    resolver = (t, ops) => {
      if (t === 'roles') return { data: null, error: null }
      if (t === 'users') return { data: null, error: null }
      if (t === 'workspace_members' && first(ops) === 'select') return { data: existing, error: null }
      if (t === 'workspace_members' && first(ops) === 'insert') return { data: { id: 'new-member' }, error: null }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
  }
  it('is replaced by the new invite instead of 409ing "already pending"', async () => {
    session = mkSession(ALL)
    inviteResolver([{ id: 'old', status: 'invited', user_id: null, invited_email: 'new@x.com', invite_token_expires_at: '2020-01-01T00:00:00Z' }])
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(req('/api/team/invite', 'POST', { email: 'new@x.com' }))
    expect(res.status).toBe(200)
    const del = calls.find(c => c.table === 'workspace_members' && first(c.ops) === 'delete')!
    expect(del.ops.find(o => o.name === 'in')!.args).toEqual(['id', ['old']])
  })
  it('a genuinely live pending invite still 409s', async () => {
    session = mkSession(ALL)
    inviteResolver([{ id: 'live', status: 'invited', user_id: null, invited_email: 'new@x.com', invite_token_expires_at: '2999-01-01T00:00:00Z' }])
    const { POST } = await import('@/app/api/team/invite/route')
    expect((await POST(req('/api/team/invite', 'POST', { email: 'new@x.com' }))).status).toBe(409)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Document numbering API
// ═════════════════════════════════════════════════════════════════════════
describe('/api/workspace/numbering', () => {
  it('GET lists all three document types with defaults when nothing is configured', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = () => ({ data: [], error: null })
    const { GET } = await import('@/app/api/workspace/numbering/route')
    const json = await (await GET()).json()
    expect(json.sequences.map((s: any) => [s.documentType, s.prefix, s.nextNumber])).toEqual([
      ['sow', 'SOW', 1], ['co', 'CO', 1], ['invoice', 'INV', 1],
    ])
  })
  it('GET/PUT need MANAGE_WORKSPACE_SETTINGS', async () => {
    session = mkSession(['VIEW_OWN_PROJECTS'])
    const { GET, PUT } = await import('@/app/api/workspace/numbering/route')
    expect((await GET()).status).toBe(403)
    expect((await PUT(req('/api/workspace/numbering', 'PUT', { documentType: 'invoice', nextNumber: 5 }))).status).toBe(403)
  })
  it('PUT rejects a bad type, a bad prefix and a bad number', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    const { PUT } = await import('@/app/api/workspace/numbering/route')
    const put = (b: any) => PUT(req('/api/workspace/numbering', 'PUT', b))
    expect((await put({ documentType: 'quote', nextNumber: 5 })).status).toBe(400)
    expect((await put({ documentType: 'invoice', prefix: 'INV-', nextNumber: 5 })).status).toBe(400)   // trailing hyphen
    expect((await put({ documentType: 'invoice', prefix: 'in v', nextNumber: 5 })).status).toBe(400)
    expect((await put({ documentType: 'invoice', prefix: 'TOOLONGPREFIX1', nextNumber: 5 })).status).toBe(400)
    expect((await put({ documentType: 'invoice', nextNumber: 0 })).status).toBe(400)
    expect((await put({ documentType: 'invoice', nextNumber: 1.5 })).status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })
  it('PUT upper-cases the prefix and calls set_document_sequence', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    rpcResolver = () => ({ data: { prefix: 'ACME-INV', next_number: 121 }, error: null })
    const { PUT } = await import('@/app/api/workspace/numbering/route')
    const res = await PUT(req('/api/workspace/numbering', 'PUT', { documentType: 'invoice', prefix: 'acme-inv', nextNumber: 121 }))
    expect(res.status).toBe(200)
    expect(rpcCalls[0]).toEqual({ name: 'set_document_sequence', args: { p_workspace_id: 'w1', p_document_type: 'invoice', p_prefix: 'ACME-INV', p_next_number: 121 } })
  })
  it('PUT turns a collision into a 409 that names the earliest usable number', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    rpcResolver = () => ({ data: null, error: { message: 'next_number_too_low:57' } })
    const { PUT } = await import('@/app/api/workspace/numbering/route')
    const res = await PUT(req('/api/workspace/numbering', 'PUT', { documentType: 'invoice', nextNumber: 10 }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.minimum).toBe(57)
    expect(json.error).toContain('INV-0057')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Billing defaults read API
// ═════════════════════════════════════════════════════════════════════════
describe('GET /api/workspace/billing-defaults', () => {
  it('returns the workspace defaults to any signed-in member', async () => {
    session = mkSession(['VIEW_OWN_PROJECTS'])
    resolver = () => ({ data: { default_tax_rate: '16.00', default_tax_inclusive: false, default_payment_terms_days: 14 }, error: null })
    const { GET } = await import('@/app/api/workspace/billing-defaults/route')
    expect(await (await GET()).json()).toEqual({ taxRate: 16, taxInclusive: false, paymentTermsDays: 14 })
  })
  it('401s when signed out', async () => {
    session = null
    const { GET } = await import('@/app/api/workspace/billing-defaults/route')
    expect((await GET()).status).toBe(401)
  })
})
