// tests/settings-team-repass-2.test.ts
//
// Regression tests for the Settings + Team & Invites deep-audit re-pass,
// round 2. Each block pins the FIXED behavior for one finding, using the
// same call-aware fake Supabase client pattern as tests/route-authority.test.ts
// (mocking @/lib/supabase/server and calling the real route handlers, rather
// than re-implementing their logic) so these exercise the actual code paths.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { sameValue } from '@/lib/utils/audit-diff'
import { PROTECTED_PERMISSIONS, describeProtectedPermission } from '@/lib/utils/admin-floor'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
const rpcCalls: Array<{ name: string; args: any }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
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
const has = (ops: Op[], n: string) => ops.some(o => o.name === n)
const arg = (ops: Op[], n: string) => ops.find(o => o.name === n)?.args

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return { data: [], error: null } },
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
const req = (url: string, method: string, body?: any, raw?: string) =>
  new NextRequest('http://localhost' + url, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers: { 'content-type': 'application/json' } })
const P = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { calls.length = 0; rpcCalls.length = 0; resolver = () => ({ data: null, error: null }) })

// ═════════════════════════════════════════════════════════════════════════
// S-1 — legal_address NULL vs {} no longer produces a false conflict
// ═════════════════════════════════════════════════════════════════════════
describe('S-1 fix: sameValue treats structurally-empty values as blank', () => {
  it('null and {} compare equal', () => {
    expect(sameValue(null, {})).toBe(true)
    expect(sameValue({}, null)).toBe(true)
    expect(sameValue(undefined, {})).toBe(true)
  })
  it('null and [] compare equal', () => {
    expect(sameValue(null, [])).toBe(true)
    expect(sameValue([], undefined)).toBe(true)
  })
  it('a NON-empty object still differs from null', () => {
    expect(sameValue({ city: 'Nairobi' }, null)).toBe(false)
  })
  it('FIX CONFIRMED: PATCH /api/workspace/settings no longer 409s on a first-ever legal_address save', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'workspaces' && first(ops) === 'select')
        return { data: { name: 'Acme', agency_name: 'Acme', industry: 'Other', currency: 'USD', timezone: 'Africa/Nairobi',
          sow_language: 'en', governing_law: 'Kenya', guardian_sensitivity_tier: 'medium', proactive_risk_alerts_enabled: true,
          proactive_risk_threshold: 10000, auto_client_reminders: false, client_reminder_after_days: 3, client_reminder_max: 3,
          tax_id: null, phone: null, website: null, default_payment_instructions: null, reply_to_email: null,
          legal_address: null, slug: 'acme', slug_changed_at: null }, error: null }
      if (t === 'workspaces' && first(ops) === 'update') return { data: [{ id: 'w1' }], error: null }
      return { data: null, error: null, count: 0 }
    }
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    // Client's baseline for a never-set address is `{}` (see SettingsClient's
    // cleanAddress()); server's stored value is `null`. This is exactly what
    // used to 409.
    const res = await PATCH(req('/api/workspace/settings', 'PATCH', {
      legalAddress: { city: 'Nairobi' }, expected: { legalAddress: {} },
    }))
    expect(res.status).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// T-1 — invite / resend now detect a provider-rejected send
// ═════════════════════════════════════════════════════════════════════════
describe('T-1 fix: checkedSend surfaces a provider rejection', () => {
  async function rejectingResend() {
    const send = await import('@/lib/email/send')
    const sent: any[] = []
    ;(send as any).__setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: null, error: { message: 'domain is not verified' } } } } })
    return sent
  }
  it('POST /api/team/invite now reports emailFailed when the provider rejects the message', async () => {
    process.env.RESEND_API_KEY = 're_test'; process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    const sent = await rejectingResend()
    session = mkSession(['INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'roles') return { data: { id: 'r1', name: 'Account Manager', permissions: { VIEW_ALL_PROJECTS: true } }, error: null }
      if (t === 'workspace_members') {
        if (has(ops, 'insert')) return { data: { id: 'm1' }, error: null }
        if (has(ops, 'delete')) return { error: null }
        return { data: [], error: null }
      }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(req('/api/team/invite', 'POST', { email: 'new@x.com', roleId: 'r1' }))
    const json = await res.json()
    expect(sent.length).toBe(1)
    expect(json.ok).toBe(true)
    expect(json.emailFailed).toBe(true)
  })

  it('POST /api/team/[id]/resend now restores the previous token when the provider rejects the message', async () => {
    process.env.RESEND_API_KEY = 're_test'; process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    const sent = await rejectingResend()
    session = mkSession(['INVITE_MEMBERS'])
    const updates: any[] = []
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select')
        return { data: { id: 'm1', status: 'invited', invited_email: 'new@x.com', user_id: null, invited_by: 'u9', invite_token: 'OLD-TOKEN', invite_token_expires_at: '2030-01-01T00:00:00Z', roles: null, users: null }, error: null }
      if (t === 'workspace_members' && first(ops) === 'update') { updates.push(arg(ops, 'update')![0]); return { error: null } }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/resend/route')
    const res = await POST(req('/api/team/m1/resend', 'POST'), P('m1'))
    const json = await res.json()
    expect(sent.length).toBe(1)
    expect(json.emailFailed).toBe(true)
    // First update wrote the new token; the rollback update restores OLD-TOKEN.
    expect(updates.length).toBe(2)
    expect(updates[1].invite_token).toBe('OLD-TOKEN')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// T-2 — signup now enforces inviter authority, matching accept
// ═════════════════════════════════════════════════════════════════════════
describe('T-2 fix: signup refuses an invite whose sender can no longer grant its role', () => {
  it('POST /api/team/invite/[token]/signup now returns 410 for a demoted inviter, same as accept', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
    const memberRow = { id: 'm1', status: 'invited', invite_token_expires_at: '2099-01-01T00:00:00Z', invited_email: 'invitee@x.com', invited_by: 'inviter1',
      workspace_id: 'w1', role_id: 'r-owner', workspaces: { name: 'Acme', deleted_at: null, plan_tier: 'agency' } }
    resolver = (t, ops) => {
      if (t === 'workspace_members') {
        if (first(ops) === 'select' && ops.some(o => o.name === 'eq' && o.args[0] === 'invite_token'))
          return { data: memberRow, error: null }
        // inviter demoted: no longer holds MANAGE_ROLES
        if (ops.some(o => o.name === 'eq' && o.args[0] === 'user_id' && o.args[1] === 'inviter1'))
          return { data: { effective_permissions: { INVITE_MEMBERS: true } }, error: null }
      }
      if (t === 'roles') return { data: { id: 'r-owner', permissions: { MANAGE_ROLES: true, INVITE_MEMBERS: true } }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/invite/[token]/signup/route')
    const res = await POST(req('/api/team/invite/tok/signup', 'POST', { name: 'New Person', password: 'a-long-enough-passphrase-9!', acceptedTerms: true }), { params: Promise.resolve({ token: 'tok' }) })
    expect(res.status).toBe(410)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// T-3 / T-5 — admin floor expanded; owner's role protected from peer edits
// ═════════════════════════════════════════════════════════════════════════
describe('T-3 fix: PROTECTED_PERMISSIONS now includes billing/invite/audit-log', () => {
  it('has exactly the five expected permissions', () => {
    expect([...PROTECTED_PERMISSIONS].sort()).toEqual(
      ['INVITE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_WORKSPACE_SETTINGS', 'MANAGE_BILLING', 'VIEW_AUDIT_LOG'].sort()
    )
  })
  it('describeProtectedPermission covers all five', () => {
    for (const p of PROTECTED_PERMISSIONS) expect(typeof describeProtectedPermission(p)).toBe('string')
  })
})

describe('T-5 fix: PATCH /api/team/roles/[id] refuses to edit a role the OWNER holds, for a non-owner actor', () => {
  it('403s a peer admin editing the role the owner holds', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return { data: { name: 'Owner', description: null, permissions: allMap(), is_default: false }, error: null }
      if (t === 'workspaces' && first(ops) === 'select') return { data: { created_by: 'owner-user' }, error: null }
      if (t === 'workspace_members') return { data: { id: 'm-owner' }, error: null } // owner holds this role
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r-owner', 'PATCH', { permissions: allMap(['MANAGE_ROLES']) }), P('r-owner'))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/owner/i)
  })
  it('allows the OWNER to edit their own role', async () => {
    session = mkSession(ALL, { id: 'owner-user' })
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return { data: { name: 'Owner', description: null, permissions: allMap(), is_default: false }, error: null }
      if (t === 'workspaces' && first(ops) === 'select') return { data: { created_by: 'owner-user' }, error: null }
      if (t === 'workspace_members') return { data: [], error: null }
      if (t === 'approval_workflow_steps') return { data: [], error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r-owner', 'PATCH', { permissions: allMap(['VIEW_PORTFOLIO']) }), P('r-owner'))
    expect(res.status).toBe(200)
  })
  it('allows editing a role the owner does NOT hold', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'roles' && first(ops) === 'select') return { data: { name: 'Finance', description: null, permissions: allMap(), is_default: false }, error: null }
      if (t === 'workspaces' && first(ops) === 'select') return { data: { created_by: 'owner-user' }, error: null }
      if (t === 'workspace_members') return { data: null, error: null } // owner does NOT hold this role (maybeSingle -> null)
      if (t === 'approval_workflow_steps') return { data: [], error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(req('/api/team/roles/r-finance', 'PATCH', { permissions: allMap(['VIEW_PORTFOLIO']) }), P('r-finance'))
    expect(res.status).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// S-6 — notification-defaults now requires explicit booleans
// ═════════════════════════════════════════════════════════════════════════
describe('S-6 fix: PATCH /api/workspace/notification-defaults requires explicit booleans', () => {
  it('400s when `enabled` is omitted, instead of silently disabling', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let inserted: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_notification_defaults') { if (has(ops, 'insert')) { inserted = arg(ops, 'insert')![0] }; return { data: null, error: null } }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/notification-defaults/route')
    const res = await PATCH(req('/api/workspace/notification-defaults', 'PATCH', { eventType: 'invoice_overdue', locked: true }))
    expect(res.status).toBe(400)
    expect(inserted).toBeNull()
  })
  it('malformed JSON now 400s instead of 500', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    const { PATCH } = await import('@/app/api/workspace/notification-defaults/route')
    const res = await PATCH(req('/api/workspace/notification-defaults', 'PATCH', undefined, '{bad'))
    expect(res.status).toBe(400)
  })
  it('still succeeds, and stores the real value, with a well-formed body', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let inserted: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_notification_defaults') { if (has(ops, 'insert')) { inserted = arg(ops, 'insert')![0] }; return { data: null, error: null } }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/workspace/notification-defaults/route')
    const res = await PATCH(req('/api/workspace/notification-defaults', 'PATCH', { eventType: 'invoice_overdue', enabled: false, locked: true }))
    expect(res.status).toBe(200)
    expect(inserted.email_enabled).toBe(false)
    expect(inserted.locked).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// S-16 / S-17 — approval workflow write-error handling
// ═════════════════════════════════════════════════════════════════════════
describe('S-17 fix: deactivate-instead-of-delete no longer reports success on a failed write', () => {
  it('500s when the update actually fails', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'approval_workflows' && first(ops) === 'select') return { data: { id: 'wf1', name: 'Big SOWs' }, error: null }
      if (t === 'approval_requests') return { count: 3, error: null }
      if (t === 'approval_workflows' && first(ops) === 'update') return { error: { message: 'boom' } }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/approval-workflows/[id]/route')
    const res = await DELETE(req('/api/approval-workflows/wf1', 'DELETE'), P('wf1'))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.deactivatedInstead).toBeUndefined()
  })
  it('still succeeds when the update actually works', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    resolver = (t, ops) => {
      if (t === 'approval_workflows' && first(ops) === 'select') return { data: { id: 'wf1', name: 'Big SOWs' }, error: null }
      if (t === 'approval_requests') return { count: 3, error: null }
      if (t === 'approval_workflows' && first(ops) === 'update') return { error: null }
      return { data: null, error: null }
    }
    const { DELETE } = await import('@/app/api/approval-workflows/[id]/route')
    const res = await DELETE(req('/api/approval-workflows/wf1', 'DELETE'), P('wf1'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.deactivatedInstead).toBe(true)
  })
})

describe('S-16 fix: workflow creation forces a failed rollback inactive rather than leaving it silently active', () => {
  it('deactivates the orphaned workflow when both the steps insert AND the rollback delete fail', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let deactivateCalled = false
    resolver = (t, ops) => {
      if (t === 'roles') return { data: [{ id: 'r1', name: 'Finance', permissions: { APPROVE_DOCUMENTS: true } }], error: null }
      if (t === 'approval_workflows' && has(ops, 'insert')) return { data: { id: 'wf-new' }, error: null }
      if (t === 'approval_workflows' && first(ops) === 'delete') return { error: { message: 'delete failed' } }
      if (t === 'approval_workflows' && first(ops) === 'update') { deactivateCalled = true; return { error: null } }
      if (t === 'approval_workflows') return { count: 0, error: null }
      if (t === 'approval_workflow_steps') return { error: { message: 'steps failed' } }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/approval-workflows/route')
    const res = await POST(req('/api/approval-workflows', 'POST', { documentType: 'sow', name: 'X', steps: [{ approverRoleId: 'r1' }] }))
    expect(res.status).toBe(500)
    expect(deactivateCalled).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// S-2 — a project-type override save no longer snapshots inherited values
// ═════════════════════════════════════════════════════════════════════════
describe('S-2 fix: POST /api/workspace/defaults stores NULL (inherit) instead of a copied value', () => {
  const globalRow = { id: 'g1', project_type: null, revision_rounds: 4, payment_structure: 'milestones', governing_law: null,
    revision_policy: 'Two rounds within 5 days', payment_terms: 'Net 14', out_of_scope_clauses: ['Hosting'], assumptions: ['Client supplies content'],
    updated_at: '2026-01-01T00:00:00Z' }

  it('a save that only touches revisionRounds leaves the untouched standards fields as NULL, not copied', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let inserted: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_defaults') {
        if (has(ops, 'insert')) { inserted = arg(ops, 'insert')![0]; return { error: null } }
        // No existing override for 'web'; global row exists.
        return { data: has(ops, 'is') ? [globalRow] : [], error: null }
      }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/workspace/defaults/route')
    // Client sends the GET-merged (inherited) values for the fields it
    // didn't touch, plus a genuinely different revisionRounds — exactly
    // what DefaultsTab.saveCurrent() does.
    const res = await POST(req('/api/workspace/defaults', 'POST', {
      projectType: 'web',
      revisionRounds: 6,                 // genuinely changed
      paymentStructure: 'milestones',    // == global -> should store as inherit (null)
      revisionPolicy: 'Two rounds within 5 days', // == global -> inherit
      paymentTerms: 'Net 14',            // == global -> inherit
      outOfScopeClauses: ['Hosting'],    // == global -> inherit
      assumptions: ['Client supplies content'], // == global -> inherit
    }))
    expect(res.status).toBe(200)
    expect(inserted.revision_rounds).toBe(6)            // real override, kept
    expect(inserted.payment_structure).toBeNull()        // matched global -> inherit
    expect(inserted.revision_policy).toBeNull()
    expect(inserted.payment_terms).toBeNull()
    expect(inserted.out_of_scope_clauses).toBeNull()
    expect(inserted.assumptions).toBeNull()
  })

  it('a genuinely different value for a standards field IS still stored as a real override', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let inserted: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_defaults') {
        if (has(ops, 'insert')) { inserted = arg(ops, 'insert')![0]; return { error: null } }
        return { data: has(ops, 'is') ? [globalRow] : [], error: null }
      }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/workspace/defaults/route')
    const res = await POST(req('/api/workspace/defaults', 'POST', {
      projectType: 'web', revisionRounds: 4, paymentStructure: 'milestones',
      revisionPolicy: 'Two rounds within 5 days', paymentTerms: 'Net 30 (web projects only)', // genuinely different
      outOfScopeClauses: ['Hosting'], assumptions: ['Client supplies content'],
    }))
    expect(res.status).toBe(200)
    expect(inserted.payment_terms).toBe('Net 30 (web projects only)')
    expect(inserted.revision_policy).toBeNull() // still matches global -> inherit
  })

  it('a later edit to the GLOBAL payment terms now reaches an override that never actually customized it', async () => {
    // Simulates the override row this fix produces (payment_terms: null),
    // then a later edit to the global row, then asks pickAgencyStandards
    // (the function SOW generation actually calls) what a "web" SOW gets.
    const { pickAgencyStandards } = await import('@/lib/utils/agency-standards')
    const overrideRow = { project_type: 'web', revision_rounds: 6, payment_structure: null, revision_policy: null, payment_terms: null, out_of_scope_clauses: null, assumptions: null }
    const updatedGlobal = { project_type: null, revision_rounds: 4, payment_structure: 'milestones', revision_policy: 'Two rounds within 5 days', payment_terms: 'Net 30 (updated)', out_of_scope_clauses: ['Hosting'], assumptions: ['Client supplies content'] }
    const picked = pickAgencyStandards([overrideRow, updatedGlobal], 'web')
    expect(picked?.paymentTerms).toBe('Net 30 (updated)') // no longer stale
  })

  it('the global (unscoped) save is unaffected — still stores literal values, no inherit logic', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let inserted: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_defaults') {
        if (has(ops, 'insert')) { inserted = arg(ops, 'insert')![0]; return { error: null } }
        return { data: [], error: null }
      }
      if (t === 'workspaces') return { data: { governing_law: null }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/workspace/defaults/route')
    const res = await POST(req('/api/workspace/defaults', 'POST', {
      revisionRounds: 3, paymentStructure: '50_50', revisionPolicy: 'One round', paymentTerms: 'Net 30',
      outOfScopeClauses: ['Print'], assumptions: ['Client provides brand assets'],
    }))
    expect(res.status).toBe(200)
    expect(inserted.revision_rounds).toBe(3)
    expect(inserted.payment_terms).toBe('Net 30')
    expect(inserted.out_of_scope_clauses).toEqual(['Print'])
  })
})
