import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Projects & Dashboard pass 10 — a failed database read is a 500 (or an explicit degrade), never a 404 / "nothing there".
// supabase-js returns { data: null, error } instead of throwing; these routes used to read `data` and ignore `error`.

type Result = { data: any; error: any }
const ok = (data: any): Result => ({ data, error: null })
const fail = (): Result => ({ data: null, error: { message: 'connection reset', code: '08006' } })

const state = vi.hoisted(() => ({
  script: {} as Record<string, any[]>,
  calls: [] as Array<{ table: string; op: string }>,
  session: null as any,
}))

function builder(table: string, result: Result) {
  const b: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit', 'range', 'gt', 'lt', 'filter']) b[m] = () => b
  for (const m of ['update', 'delete', 'insert', 'upsert']) b[m] = () => { state.calls.push({ table, op: m }); return b }
  b.maybeSingle = () => b
  b.single = () => b
  b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q = state.script[table]
      const next = q && q.length ? q.shift() : ok(null)
      return builder(table, next)
    },
    rpc: async () => ok(null),
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => state.session,
  getSessionStrict: async () => state.session,
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {}, insertAuditRow: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyUsers: async () => {} }))
vi.mock('@/lib/approvals/engine', () => ({
  getPendingApprovalForDocument: async () => null, cancelApprovalRequest: async () => ({ cancelled: true }),
  projectApprovalSendInFlight: async () => false, SEND_IN_FLIGHT_MESSAGE: 'in flight',
}))
vi.mock('@/lib/utils/project-limit', () => ({
  wouldExceedLimit: async () => false, isOverLimit: async () => false, isProjectBeyondLimit: async () => false,
  projectLimitMessage: () => 'limit',
}))

const PID = '11111111-1111-1111-1111-111111111111'
const params = { params: Promise.resolve({ id: PID }) }
const req = (body?: any) => ({ json: async () => body ?? {}, url: `http://x/api/projects/${PID}` }) as any

beforeEach(() => {
  state.script = {}
  state.calls = []
  state.session = { id: 'u1', workspaceId: 'w1', name: 'Mas', email: 'm@x.com', planTier: 'pro' }
})

const liveProject = { id: PID, name: 'P', disc: null, status: 'Active', stall_reason: null, type: 'fixed', client_id: 'c1',
  currency: 'USD', contract_value: 100, start_date: null, internal_ref: null, retainer_duration_months: null, sow_documents: [] }

describe('PATCH /api/projects/[id]', () => {
  it('a failed project read is a 500, not a 404', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [fail()]
    const res = await PATCH(req({ name: 'New' }), params)
    expect(res.status).toBe(500)
  })

  it('the pre-write SOW re-check FAILS CLOSED: a failed read blocks the write instead of passing every lock', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [ok(liveProject), fail()]
    const res = await PATCH(req({ contractValue: 500 }), params)
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.table === 'projects' && c.op === 'update')).toHaveLength(0)
  })

  it('a project that vanished between the read and the re-check is a 409, not a silent pass', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [ok(liveProject), ok(null)]
    const res = await PATCH(req({ contractValue: 500 }), params)
    expect(res.status).toBe(409)
    expect(state.calls.filter(c => c.op === 'update')).toHaveLength(0)
  })

  it('a project with a signed SOW still blocks a re-price when the re-check read succeeds (control)', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/route')
    const signed = { ...liveProject, sow_documents: [{ id: 's1', status: 'signed' }] }
    state.script.projects = [ok(signed)]
    const res = await PATCH(req({ contractValue: 500 }), params)
    expect(res.status).toBe(409)
  })
})

describe('GET / DELETE /api/projects/[id]', () => {
  it('GET: failed read is 500', async () => {
    const { GET } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [fail()]
    expect((await GET(req(), params)).status).toBe(500)
  })
  it('GET: a genuinely missing project is still 404', async () => {
    const { GET } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [ok(null)]
    expect((await GET(req(), params)).status).toBe(404)
  })
  it('DELETE: failed read is 500 and nothing is deleted', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/route')
    state.script.projects = [fail()]
    const res = await DELETE(req(), params)
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.op === 'update')).toHaveLength(0)
  })
})

describe('status-transition routes', () => {
  for (const name of ['archive', 'unarchive', 'reopen', 'complete'] as const) {
    it(`${name}: a failed project read is 500, never 404, and writes nothing`, async () => {
      const { POST } = await import(`@/app/api/projects/[id]/${name}/route`)
      state.script.projects = [fail()]
      const res = await POST(req(), params)
      expect(res.status).toBe(500)
      expect(state.calls.filter(c => c.op === 'update')).toHaveLength(0)
    })
  }
})

describe('members routes', () => {
  const MID = '22222222-2222-2222-2222-222222222222'
  it('POST: a failed member lookup is 500, not "Member not found"', async () => {
    const { POST } = await import('@/app/api/projects/[id]/members/route')
    state.script.projects = [ok({ id: PID, name: 'P' })]
    state.script.workspace_members = [fail()]
    const res = await POST(req({ memberId: MID }), params)
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.table === 'project_members')).toHaveLength(0)
  })
  it('DELETE: a failed lookup of who is being removed stops BEFORE the delete', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/members/route')
    state.script.projects = [ok({ id: PID, name: 'P' })]
    state.script.workspace_members = [fail()]
    const res = await DELETE(req({ memberId: MID }), params)
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.table === 'project_members' && c.op === 'delete')).toHaveLength(0)
  })
  it('available: a failed "already on the project" read is 500, not a list of everybody', async () => {
    const { GET } = await import('@/app/api/projects/[id]/members/available/route')
    state.script.projects = [ok({ id: PID })]
    state.script.project_members = [fail()]
    expect((await GET(req(), params)).status).toBe(500)
  })
})

describe('discussion routes', () => {
  it('read marker: a failed read of the current marker never writes (it could move the marker backwards)', async () => {
    const { POST } = await import('@/app/api/projects/[id]/messages/read/route')
    state.script.project_message_reads = [fail()]
    const res = await POST(req({ upTo: '2020-01-01T00:00:00.000Z' }), params)
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.op === 'upsert')).toHaveLength(0)
  })
  it('unread count: a failed count is 500, not { count: 0 }', async () => {
    const { GET } = await import('@/app/api/projects/[id]/messages/unread-count/route')
    state.script.project_message_reads = [ok({ last_read_at: '2026-01-01T00:00:00Z' })]
    state.script.project_messages = [{ data: null, error: { message: 'boom' }, count: null } as any]
    expect((await GET(req(), params)).status).toBe(500)
  })
  it('unread count: a failed marker read is 500, not "everything unread"', async () => {
    const { GET } = await import('@/app/api/projects/[id]/messages/unread-count/route')
    state.script.project_message_reads = [fail()]
    expect((await GET(req(), params)).status).toBe(500)
  })
  it('message edit: a failed message lookup is 500, not 404', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/messages/[messageId]/route')
    state.script.project_messages = [fail()]
    const res = await PATCH(req({ body: 'hello' }), { params: Promise.resolve({ id: PID, messageId: 'm1' }) })
    expect(res.status).toBe(500)
  })
  it('message edit: a failed read of existing mentions skips reconciliation instead of inserting duplicates', async () => {
    const { PATCH } = await import('@/app/api/projects/[id]/messages/[messageId]/route')
    const U = '33333333-3333-3333-3333-333333333333'
    state.script.project_messages = [
      ok({ id: 'm1', author_id: 'u1', deleted_at: null, project_id: PID, workspace_id: 'w1' }),
      ok([{ id: 'm1' }]),
    ]
    state.script.project_members_active = [ok([{ member_user_id: U }])]
    state.script.workspace_members = [ok([{ user_id: U, effective_permissions: {}, users: { id: U, name: 'Una', email: 'u@x.com', avatar_url: null } }])]
    state.script.project_message_mentions = [fail()]
    const res = await PATCH(req({ body: `hi @[Una](${U})` }), { params: Promise.resolve({ id: PID, messageId: 'm1' }) })
    expect(res.status).toBe(200)
    expect(state.calls.filter(c => c.table === 'project_message_mentions')).toHaveLength(0)
  })
})

describe('listMentionable', () => {
  it('throws on a failed read instead of returning an empty list (which silently stripped real @mentions)', async () => {
    const { listMentionable, resolveMentions } = await import('@/lib/utils/project-messages')
    const U = '44444444-4444-4444-4444-444444444444'
    state.script.project_members_active = [fail()]
    state.script.workspace_members = [ok([])]
    const svc = (await import('@/lib/supabase/server')).createServiceClient()
    await expect(listMentionable(svc, 'w1', PID)).rejects.toThrow(/mentionable/)
    state.script.project_members_active = [ok([])]
    state.script.workspace_members = [fail()]
    await expect(resolveMentions(svc, 'w1', PID, `hi @[Una](${U})`)).rejects.toThrow()
  })
})

describe('POST /api/projects', () => {
  it('a failed creator-membership lookup rolls the project back and fails — it never returns a project its creator cannot open', async () => {
    const { POST } = await import('@/app/api/projects/route')
    state.script.clients = [ok({ id: 'c1', name: 'C', status: 'active' })]
    state.script.projects = [ok({ id: PID }), ok(null)]
    state.script.workspace_members = [fail()]
    const res = await POST(req({ name: 'Site', type: 'web', clientId: 'c1', contractValue: 100 }))
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.table === 'projects' && c.op === 'delete')).toHaveLength(1)
    expect(state.calls.filter(c => c.table === 'project_members')).toHaveLength(0)
  })
  it('a failed client lookup is 500, not "Client not found"', async () => {
    const { POST } = await import('@/app/api/projects/route')
    state.script.clients = [fail()]
    const res = await POST(req({ name: 'Site', type: 'web', clientId: 'c1', contractValue: 100 }))
    expect(res.status).toBe(500)
    expect(state.calls.filter(c => c.table === 'projects')).toHaveLength(0)
  })
})

describe('server pages (source-level guards — they render RSC and cannot be invoked here)', () => {
  const page = readFileSync('app/(app)/projects/[id]/page.tsx', 'utf8')
  it('the project page throws on a failed project read instead of calling notFound()', () => {
    expect(page).toMatch(/if \(projectErr\) throw new Error/)
    // the real statement, not the historical comment that quotes it
    expect(page.indexOf('\n  if (projectErr) throw')).toBeLessThan(page.indexOf('\n  if (!project) notFound()'))
    expect(page).toMatch(/\.maybeSingle\(\)\s*\n\s*\n\s*if \(projectErr\)/)
  })
  it('milestones, amendments, team and invoices each check their read error', () => {
    for (const e of ['milestonesErr', 'amendmentsErr', 'teamErr', 'invoicesErr'])
      expect(page).toMatch(new RegExp(`if \\(${e}\\) throw new Error`))
  })
  it('dashboard and list log a failed workspace-settings read', () => {
    expect(readFileSync('app/(app)/dashboard/page.tsx', 'utf8')).toMatch(/if \(wsErr\) console\.error/)
    expect(readFileSync('app/(app)/projects/page.tsx', 'utf8')).toMatch(/if \(wsErr\) console\.error/)
  })
})

describe('FlagCollaboration + SOW editor page (source-level guards)', () => {
  const fc = readFileSync('components/projects/FlagCollaboration.tsx', 'utf8')
  it('every write handler has a catch, and none calls res.json() bare', () => {
    expect(fc).not.toMatch(/await res\.json\(\)/)
    for (const fn of ['submitComment', 'submitFile', 'deleteAttachment']) {
      const body = fc.slice(fc.indexOf(`async function ${fn}`))
      const upToNext = body.slice(0, body.indexOf('\n  }\n') + 5)
      expect(upToNext).toMatch(/catch \{/)
    }
  })
  it('Enter does not send while an IME composition is active', () => {
    expect(fc).toMatch(/!e\.nativeEvent\.isComposing/)
  })
  const sowPage = readFileSync('app/(app)/projects/[id]/sow/[sowId]/page.tsx', 'utf8')
  it('the SOW page distinguishes a failed load from "not found", and checks the project in the URL', () => {
    expect(sowPage).toMatch(/\.catch\(\(\) => \{ if \(!cancelled\) setLoadFailed\(true\) \}\)/)
    expect(sowPage).toMatch(/json\.sow\.project_id === projId/)
  })
})
