import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// CO logic, independent pass 6 (c10: api/co/*, components/co, api/pdf/co). Route tests below load the REAL route
// handlers (dynamic import, after vi.mock) against an in-memory table and mock only the boundary modules.
//
//   1. close / withdraw / exception / revise cancelled the CO's approval requests AFTER flipping its status and ignored
//      `blockedBySend`, so a final approval racing the pre-check left a closed CO with an unretryable
//      "Approved - not sent". They now cancel FIRST and refuse (409) when a send is live, like invoice DELETE.
//   2. exception: a withdrawn/closed NEWER version blocked an exception on the version before it, with a message pointing
//      at a version that could not take one either.
//   3. Guardian draft_co wrote up-to-1000-char flag text into a 500-char line field the editor then refused to save.
//   4. the internal CO PDF skipped the note sanitizer the portal PDF applies.
//   5. send: the one-live-version check ran only after the approval gate, so a doomed send still created an approval.
//   6. co/draft: rate limit was check-then-record around a multi-second model call (parallel burst bypassed it).
//   8. co/draft returned a title/note with no line items as success; the editor half-applied it.

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

// ---------------------------------------------------------------------------------------------------------------
// In-memory table + boundary mocks
// ---------------------------------------------------------------------------------------------------------------
const state: any = { db: {} as Record<string, any[]>, calls: [] as string[], cancelBlocked: false, inFlight: false, modelReply: null, claim: { allowed: true, message: '' } }
let idc = 0
function parseOr(expr: string) {
  const parts = expr.split(',')
  return (r: any) => parts.some(p => {
    const [col, op, ...rest] = p.split('.'); const val = rest.join('.')
    if (op === 'eq') return String(r[col]) === val
    if (op === 'is' && val === 'null') return (r[col] ?? null) === null
    return false
  })
}
function table(name: string) {
  const filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'; let payload: any = null
  let single = false, maybe = false, wantRows = false, lim: number | null = null, orderBy: any = null
  const b: any = {
    select: () => { wantRows = true; return b },
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
    neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return b },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return b },
    in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return b },
    lt: (c: string, v: any) => { filters.push(r => r[c] < v); return b },
    or: (e: string) => { filters.push(parseOr(e)); return b },
    order: (c: string, o: any) => { orderBy = { c, asc: o?.ascending !== false }; return b },
    limit: (n: number) => { lim = n; return b },
    single: () => { single = true; return b },
    maybeSingle: () => { maybe = true; return b },
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    delete: () => { op = 'delete'; return b },
    then: (res: any, rej: any) => {
      const rows = (state.db[name] = state.db[name] || [])
      const hit = () => rows.filter((r: any) => filters.every(f => f(r)))
      let result: any
      if (op === 'insert') {
        const arr = Array.isArray(payload) ? payload : [payload]
        const made = arr.map((p: any) => { const row = { id: p.id || `${name}-${++idc}`, ...p }; rows.push(row); return row })
        state.calls.push(`db.insert:${name}`)
        result = { data: single ? made[0] : wantRows ? made : null, error: null }
      } else if (op === 'update') {
        const h = hit()
        h.forEach((r: any) => Object.assign(r, payload))
        state.calls.push(`db.update:${name}${payload.status ? ':' + payload.status : ''}`)
        result = { data: wantRows ? (maybe ? (h[0] ?? null) : h) : null, error: null }
      } else if (op === 'delete') {
        const h = hit(); h.forEach((r: any) => rows.splice(rows.indexOf(r), 1))
        state.calls.push(`db.delete:${name}`)
        result = { data: wantRows ? h : null, error: null }
      } else {
        let h = hit()
        if (orderBy) h = [...h].sort((a: any, c: any) => (a[orderBy.c] < c[orderBy.c] ? -1 : 1) * (orderBy.asc ? 1 : -1))
        if (lim != null) h = h.slice(0, lim)
        if (single) result = h.length === 1 ? { data: h[0], error: null } : { data: null, error: { message: 'no rows' } }
        else if (maybe) result = { data: h[0] ?? null, error: null }
        else result = { data: h, error: null }
      }
      return Promise.resolve(result).then(res, rej)
    },
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => table(t) }) }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.co', name: 'Ann', workspaceId: 'w1', emailVerifiedAt: 'yes' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, e: any) => { state.calls.push('audit:' + e.eventType); return true } }))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/approvals/engine', () => ({
  SEND_IN_FLIGHT_MESSAGE: 'SEND_IN_FLIGHT',
  approvalSendInFlight: async () => state.inFlight,
  cancelApprovalRequest: async (_s: any, p: any) => { state.calls.push('cancel:' + p.documentType); return { cancelled: false, blockedBySend: state.cancelBlocked } },
  evaluateApprovalGate: async () => { state.calls.push('gate'); return { requiresApproval: false, blocked: false } },
}))
vi.mock('@/lib/email/templates', () => ({ sendDocumentCancelledEmail: async () => ({}), sendCoExceptionGrantedEmail: async () => ({}) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async (fn: any) => { await fn(); return { ok: true } } }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => null }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: async () => [] }))
vi.mock('@/lib/documents/send-co', () => ({
  sendCoDocument: async () => { state.calls.push('sendCoDocument'); return { ok: true, token: 't', emailSent: true } },
  validateCoForSend: () => null, renewalNeedsTerm: () => false,
}))
vi.mock('@/lib/documents/preflight', () => ({ sendBlockedReason: async () => null }))
vi.mock('@/lib/approvals/gate-amount', () => ({ coGateAmount: () => 100 }))
vi.mock('@/lib/utils/rate-limit', () => ({ claimAiRateSlot: async () => { state.calls.push('claim'); return state.claim } }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async () => { state.calls.push('model'); return state.modelReply } } },
}))
vi.mock('@/lib/pdf/renderer', () => ({ renderCoPdf: async (d: any) => { state.captured = d; return Buffer.from('%PDF') } }))
vi.mock('@/lib/documents/co-contract-value', () => ({ getContractValueBefore: async () => 0 }))
vi.mock('@/lib/documents/executed-pdf', () => ({ fetchExecutedPdf: async () => null }))

const project = { id: 'p1', name: 'Site', status: 'Active', currency: 'USD', type: 'project', client_id: 'c1', clients: { name: 'C', email: 'c@c.co', cc_emails: [] }, workspaces: { agency_name: 'A', brand_colour: '#000' } }
const co = (o: any = {}) => ({ id: 'aaaaaaaa-0000-4000-8000-000000000001', workspace_id: 'w1', title: 'T', status: 'draft', flag_id: null, token: null, project_id: 'p1', total: 100, version: 1, root_co_id: null, projects: project, ...o })
const status = (id = 'aaaaaaaa-0000-4000-8000-000000000001') => state.db.change_orders.find((r: any) => r.id === id)?.status
const mkReq = (body: any = {}) => ({ json: async () => body }) as any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { state.db = {}; state.calls = []; state.cancelBlocked = false; state.inFlight = false; state.captured = null; state.claim = { allowed: true, message: '' } })

// ---------------------------------------------------------------------------------------------------------------
// 1. cancel BEFORE the status flip, refuse when a send is live
// ---------------------------------------------------------------------------------------------------------------
describe('close / withdraw: approvals are cancelled before the status write and a live send is refused', () => {
  it('close refuses (409) and leaves the CO untouched when the cancel is blocked by a live send', async () => {
    const { POST } = await import('@/app/api/co/[id]/close/route')
    state.db = { change_orders: [co()] }; state.cancelBlocked = true
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(409)
    expect(status()).toBe('draft')
    expect(state.calls).not.toContain('audit:co.closed')
  })
  it('close cancels both request kinds BEFORE writing the status', async () => {
    const { POST } = await import('@/app/api/co/[id]/close/route')
    state.db = { change_orders: [co()] }
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(200)
    expect(status()).toBe('closed')
    expect(state.calls).toContain('cancel:co')
    expect(state.calls).toContain('cancel:co_counter')
    expect(state.calls.indexOf('cancel:co')).toBeLessThan(state.calls.indexOf('db.update:change_orders:closed'))
  })
  it('withdraw refuses (409) and leaves the CO untouched when the cancel is blocked', async () => {
    const { POST } = await import('@/app/api/co/[id]/withdraw/route')
    state.db = { change_orders: [co()] }; state.cancelBlocked = true
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(409)
    expect(status()).toBe('draft')
  })
  it('withdraw cancels BEFORE writing the status', async () => {
    const { POST } = await import('@/app/api/co/[id]/withdraw/route')
    state.db = { change_orders: [co()] }
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(200)
    expect(status()).toBe('withdrawn')
    expect(state.calls.indexOf('cancel:co')).toBeLessThan(state.calls.indexOf('db.update:change_orders:withdrawn'))
  })
})

describe('exception: cancel ordering and the newer-version guard', () => {
  const body = { reason: 'goodwill' }
  it('refuses (409), removes the ledger row and leaves the CO alone when the cancel is blocked', async () => {
    const { POST } = await import('@/app/api/co/[id]/exception/route')
    state.db = { change_orders: [co()], exceptions_log: [] }; state.cancelBlocked = true
    const res = await POST(mkReq(body), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(409)
    expect(status()).toBe('draft')
    expect(state.db.exceptions_log).toHaveLength(0)
  })
  it('a normal grant keeps its ledger row and cancels before the status write', async () => {
    const { POST } = await import('@/app/api/co/[id]/exception/route')
    state.db = { change_orders: [co()], exceptions_log: [] }
    const res = await POST(mkReq(body), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(200)
    expect(status()).toBe('exception_granted')
    expect(state.db.exceptions_log).toHaveLength(1)
    expect(state.calls.indexOf('cancel:co')).toBeLessThan(state.calls.indexOf('db.update:change_orders:exception_granted'))
  })

  const sib = (v: number, s: string) => co({ id: 'v' + v, status: s, version: v, root_co_id: 'aaaaaaaa-0000-4000-8000-000000000001' })
  const cases: Array<[string, Array<[number, string]>, number, RegExp | null]> = [
    ['newer withdrawn version does not block', [[2, 'withdrawn']], 200, null],
    ['newer closed version does not block', [[2, 'closed']], 200, null],
    ['withdrawn then closed versions do not block', [[2, 'withdrawn'], [3, 'closed']], 200, null],
    ['a live newer version blocks and is named', [[2, 'awaiting_response']], 409, /v2.*grant the exception on that one/],
    ['a newer draft blocks and is named', [[2, 'draft']], 409, /v2.*grant the exception on that one/],
    ['a newer declined version blocks and is named (it can take the exception)', [[2, 'declined']], 409, /v2.*grant the exception on that one/],
    ['a newer accepted version blocks WITHOUT telling the user to use it', [[2, 'accepted']], 409, /v2.*is accepted, so an exception can't/],
    ['a newer already-excepted version blocks WITHOUT telling the user to use it', [[2, 'exception_granted']], 409, /exception can't be granted on this one/],
    ['the newest BLOCKING version is the one named', [[2, 'withdrawn'], [3, 'declined']], 409, /v3.*grant the exception on that one/],
  ]
  for (const [name, sibs, want, msg] of cases) {
    it(name, async () => {
      const { POST } = await import('@/app/api/co/[id]/exception/route')
      state.db = { change_orders: [co({ status: 'declined' }), ...sibs.map(([v, s]) => sib(v, s))], exceptions_log: [] }
      const res = await POST(mkReq(body), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
      expect(res.status).toBe(want)
      if (msg) expect((await res.json()).error).toMatch(msg)
    })
  }
  it('the newest version is never blocked by an OLDER one', async () => {
    const { POST } = await import('@/app/api/co/[id]/exception/route')
    state.db = { change_orders: [co({ id: 'v1', status: 'declined', version: 1 }), co({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'declined', version: 2, root_co_id: 'v1' })], exceptions_log: [] }
    const res = await POST(mkReq(body), ctx('aaaaaaaa-0000-4000-8000-000000000002'))
    expect(res.status).toBe(200)
  })
})

describe('revise (countered): the co_counter request is cancelled before the original is superseded', () => {
  const seed = () => ({ change_orders: [co({ status: 'countered', line_items: [], subtotal: 100 })], co_attachments: [] })
  it('backs out when a send is live: 409, the original stays countered, the revision draft is removed', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = seed(); state.cancelBlocked = true
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(409)
    expect(status()).toBe('countered')
    expect(state.db.change_orders).toHaveLength(1)
  })
  it('a normal revise cancels first, then supersedes and leaves a draft', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = seed()
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(200)
    expect(status()).toBe('closed')
    expect(state.db.change_orders).toHaveLength(2)
    expect(state.calls.indexOf('cancel:co_counter')).toBeLessThan(state.calls.indexOf('db.update:change_orders:closed'))
  })
  it('reviving a declined CO is unchanged', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = { change_orders: [co({ status: 'declined', line_items: [], subtotal: 100 })], co_attachments: [] }
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    expect(res.status).toBe(200)
    expect(state.db.change_orders).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 5. send: one-live-version check before the approval gate
// ---------------------------------------------------------------------------------------------------------------
describe('send: a live sibling is refused BEFORE the approval gate', () => {
  const seed = (siblingStatus: string) => ({
    change_orders: [
      co({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'draft', version: 2, root_co_id: 'aaaaaaaa-0000-4000-8000-000000000001', line_items: [{ description: 'x', quantity: 1, rate: 100, total: 100 }] }),
      co({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: siblingStatus, version: 1 }),
    ],
    sow_documents: [{ id: 's', project_id: 'p1', status: 'signed' }],
  })
  it('409s, creates no approval request and sends nothing', async () => {
    const { POST } = await import('@/app/api/co/[id]/send/route')
    state.db = seed('awaiting_response')
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000002'))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Version 1.*still open/)
    expect(state.calls).not.toContain('gate')
    expect(state.calls).not.toContain('sendCoDocument')
  })
  it('with no live sibling the gate runs and the send proceeds', async () => {
    const { POST } = await import('@/app/api/co/[id]/send/route')
    state.db = seed('declined')
    const res = await POST(mkReq({}), ctx('aaaaaaaa-0000-4000-8000-000000000002'))
    expect(res.status).toBe(200)
    expect(state.calls).toContain('gate')
    expect(state.calls).toContain('sendCoDocument')
  })
  it('send-co.ts still runs the same check for the auto-send path, from the shared helper', () => {
    const src = read('lib/documents/send-co.ts')
    expect(src).toMatch(/liveCoSiblingMessage\(service/)
    expect(src).not.toMatch(/\.in\('status', \['awaiting_response'/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 6 + 8. co/draft
// ---------------------------------------------------------------------------------------------------------------
describe('co/draft route', () => {
  const seed = () => ({ projects: [{ id: 'p1', workspace_id: 'w1', name: 'Site', type: 'project', status: 'Active', contract_value: 1000, currency: 'USD', deleted_at: null, project_scope_snapshot: { deliverables: [], out_of_scope: [] } }] })
  const tool = (input: any) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input }] })
  const post = async (reply: any) => {
    const { POST } = await import('@/app/api/co/draft/route')
    state.db = seed(); state.modelReply = reply
    return POST(mkReq({ projectId: 'p1', request: 'Client wants two more pages' }))
  }
  it('claims its rate-limit slot BEFORE the model call', async () => {
    const res = await post(tool({ title: 'Extra pages', note: 'Two pages.', lineItems: [{ description: 'Page build', quantity: 2 }] }))
    expect(res.status).toBe(200)
    expect(state.calls.indexOf('claim')).toBeGreaterThanOrEqual(0)
    expect(state.calls.indexOf('claim')).toBeLessThan(state.calls.indexOf('model'))
  })
  it('never calls the model when over the limit (429)', async () => {
    state.claim = { allowed: false, message: 'Too many requests' }
    const res = await post(tool({ title: 'x', note: 'y', lineItems: [{ description: 'a', quantity: 1 }] }))
    expect(res.status).toBe(429)
    expect(state.calls).not.toContain('model')
  })
  it('refuses (422) a reply with a title and note but no line items instead of returning a half-draft', async () => {
    const res = await post(tool({ title: 'Extra pages', note: 'Two pages.', lineItems: [] }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/line items/)
  })
  it('counts lines that are blank after sanitization as no lines', async () => {
    const res = await post(tool({ title: 'x', note: 'y', lineItems: [{ description: '   ', quantity: 1 }] }))
    expect(res.status).toBe(422)
  })
  it('the editor applies a draft all-or-nothing and hides AI drafting on credit COs', () => {
    const ed = read('components/co/CoEditor.tsx')
    expect(ed.indexOf("if (!json.lineItems?.length) throw")).toBeGreaterThan(-1)
    expect(ed.indexOf("if (!json.lineItems?.length) throw")).toBeLessThan(ed.indexOf('if (json.title) setTitle(json.title)'))
    expect(ed).toMatch(/!isLocked && !financialsHidden && !isCredit && !aiOpen/)
    expect(ed).toMatch(/!isLocked && !financialsHidden && !isCredit && aiOpen/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 6. claimAiRateSlot (real function, fake table with round-trip latency)
// ---------------------------------------------------------------------------------------------------------------
describe('claimAiRateSlot bounds a parallel burst (real implementation)', () => {
  const RTT = () => new Promise(r => setTimeout(r, 3))
  function fakeService(opts: { insertErr?: boolean; countErr?: boolean } = {}) {
    const rows: any[] = []; let n = 0
    const svc: any = { rows, from: () => {
      const f: Array<(r: any) => boolean> = []; let op = 'select', payload: any
      const b: any = {
        insert: (p: any) => { op = 'insert'; payload = p; return b }, delete: () => { op = 'delete'; return b },
        select: () => b, single: () => b,
        eq: (c: string, v: any) => { f.push(r => r[c] === v); return b },
        gte: (c: string, v: any) => { f.push(r => r[c] >= v); return b },
        then: (res: any, rej: any) => RTT().then(() => {
          if (op === 'insert') { if (opts.insertErr) return { data: null, error: { message: 'x' } }; const row = { id: ++n, ...payload, created_at: new Date().toISOString() }; rows.push(row); return { data: { id: row.id }, error: null } }
          if (op === 'delete') { rows.filter(r => f.every(x => x(r))).forEach(r => rows.splice(rows.indexOf(r), 1)); return { data: null, error: null } }
          if (opts.countErr) return { count: null, error: { message: 'x' } }
          return { count: rows.filter(r => f.every(x => x(r))).length, error: null }
        }).then(res, rej),
      }
      return b } }
    return svc
  }
  const claim = async (s: any, u = 'u1') => (await vi.importActual<any>('@/lib/utils/rate-limit')).claimAiRateSlot(s, 'w1', u, 'co.draft') // limit 20 / 10 min

  it('never lets more than the limit through a simultaneous burst, and leaks no slots', async () => {
    const s = fakeService()
    const r = await Promise.all(Array.from({ length: 40 }, () => claim(s)))
    const ok = r.filter((x: any) => x.allowed).length
    expect(ok).toBeLessThanOrEqual(20)
    expect(s.rows.length).toBe(ok)
  })
  it('never lets more than the limit through a staggered burst, and the unclaimed capacity stays claimable', async () => {
    const s = fakeService(); const ps: Promise<any>[] = []
    for (let i = 0; i < 40; i++) { ps.push(claim(s)); await new Promise(r => setTimeout(r, 2)) }
    const ok = (await Promise.all(ps)).filter((x: any) => x.allowed).length
    expect(ok).toBeLessThanOrEqual(20)
    expect(s.rows.length).toBe(ok)
    let extra = 0; for (let i = 0; i < 25; i++) if ((await claim(s)).allowed) extra++
    expect(extra).toBe(20 - ok)
  })
  it('steady state: 20 pass, the 21st is refused with the 429 message and does not eat the window', async () => {
    const s = fakeService(); let allowed = 0
    for (let i = 0; i < 20; i++) if ((await claim(s)).allowed) allowed++
    expect(allowed).toBe(20)
    const r = await claim(s)
    expect(r.allowed).toBe(false)
    expect(r.message).toMatch(/Too many requests/)
    expect(s.rows.length).toBe(20)
  })
  it('is per user, and fails OPEN on a database error', async () => {
    const s = fakeService(); for (let i = 0; i < 20; i++) await claim(s)
    expect((await claim(s, 'u2')).allowed).toBe(true)
    expect((await claim(fakeService({ insertErr: true }))).allowed).toBe(true)
    expect((await claim(fakeService({ countErr: true }))).allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 3. Guardian draft_co line description fits the editor's limit
// ---------------------------------------------------------------------------------------------------------------
describe('flag-drafted CO line description fits the editor\'s 500-character limit', () => {
  it('guardian draft_co caps the line with the editor\'s own constant', () => {
    const src = read('app/api/guardian/flags/[id]/route.ts')
    expect(src).toMatch(/description: truncateText\(String\(flag\.description \?\? ''\), MAX_DESCRIPTION_LEN\)/)
    expect(src).not.toMatch(/description: flag\.description,\s*\n\s*quantity:\s*1/)
    expect(read('lib/documents/co-totals.ts')).toMatch(/export const MAX_DESCRIPTION_LEN = 500/)
  })
  it('a worst-case 1000-char flag (emoji on the cut) survives the cap and the editor\'s first save', async () => {
    const { MAX_DESCRIPTION_LEN, computeCoTotals } = await import('@/lib/documents/co-totals')
    const { truncateText } = await import('@/lib/utils/sanitize')
    const flagText = 'x'.repeat(MAX_DESCRIPTION_LEN - 1) + '\u{1F600}' + 'y'.repeat(500)
    expect(computeCoTotals([{ description: flagText, quantity: 1, rate: 0 }], 0, false).ok).toBe(false)   // the bug
    const capped = truncateText(flagText, MAX_DESCRIPTION_LEN)
    expect(capped.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped)).toBe(false)
    expect(computeCoTotals([{ description: capped, quantity: 1, rate: 0 }], 0, false).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 4. internal CO PDF sanitizes the note like the portal PDF
// ---------------------------------------------------------------------------------------------------------------
describe('internal CO PDF re-sanitizes the note', () => {
  const base = { id: 'aaaaaaaa-0000-4000-8000-000000000001', workspace_id: 'w1', title: 'T', status: 'draft', version: 1, document_number: null, pdf_path: null, is_retainer_renewal: false, is_credit: false, line_items: [], subtotal: 0, tax_rate: 0, tax_inclusive: false, total: 0, project_id: 'p1', projects: { id: 'p1', name: 'S', type: 'project', currency: 'USD', contract_value: 100, clients: { name: 'C' }, workspaces: { agency_name: 'A' } } }
  const render = async (note: string | null) => {
    const { GET } = await import('@/app/api/pdf/co/[id]/route')
    state.db = { change_orders: [{ ...base, note }] }
    await GET(mkReq(), ctx('aaaaaaaa-0000-4000-8000-000000000001'))
    return state.captured
  }
  it('what reaches the renderer is exactly what the sanitizer returns (no scripts, no handlers)', async () => {
    const { sanitizeRichTextOrNull } = await import('@/lib/utils/sanitize')
    const hostile = '<p>Scope <b>ok</b> &amp; fine</p><script>steal()</script><a href="https://x.co" onclick="evil()">link</a>'
    const data = await render(hostile)
    expect(data.note).toBe(sanitizeRichTextOrNull(hostile))
    expect(data.note).not.toMatch(/<script|steal\(\)|onclick/)
    expect(data.note).toContain('<b>ok</b>')
  })
  it('an empty-paragraph note becomes null; a null note stays null', async () => {
    expect((await render('<p></p>')).note).toBeNull()
    expect((await render(null)).note).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Source guards for the shared helpers
// ---------------------------------------------------------------------------------------------------------------
describe('no CO route calls cancelApprovalRequest directly any more', () => {
  for (const r of ['close', 'withdraw', 'exception', 'revise']) {
    it(`${r} goes through cancelCoApprovals and honours blockedBySend`, () => {
      const src = read(`app/api/co/[id]/${r}/route.ts`)
      expect(src).toMatch(/cancelCoApprovals\(service/)
      expect(src).not.toMatch(/cancelApprovalRequest\(/)
      expect(src).toMatch(/cancelled\.blockedBySend/)
    })
  }
})
