import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// CO logic, independent pass 7 (c10). Revise of a COUNTERED change order inserts the revision draft BEFORE it
// supersedes the original. Only the blocked-send and lost-race exits removed that draft again: when the approval
// lookup inside cancelCoApprovals THREW (it deliberately throws on a failed read) the route 500'd with the draft
// left behind and the original still 'countered'. Retrying then hit the early "an open draft exists" return, which
// handed the stray draft back WITHOUT ever closing the original, so the draft could not be sent (the original is a
// live sibling) and a countered CO cannot be withdrawn.


// ---------------------------------------------------------------------------------------------------------------
// In-memory table + boundary mocks
// ---------------------------------------------------------------------------------------------------------------
const state: any = { db: {} as Record<string, any[]>, calls: [] as string[], cancelBlocked: false, cancelThrows: false, inFlight: false, modelReply: null, claim: { allowed: true, message: '' } }
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
  cancelApprovalRequest: async (_s: any, p: any) => { state.calls.push('cancel:' + p.documentType); if (state.cancelThrows) throw new Error('could not look up the approval request to cancel: boom'); return { cancelled: false, blockedBySend: state.cancelBlocked } },
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
const co = (o: any = {}) => ({ id: 'co1', workspace_id: 'w1', title: 'T', status: 'draft', flag_id: null, token: null, project_id: 'p1', total: 100, version: 1, root_co_id: null, projects: project, ...o })
const status = (id = 'co1') => state.db.change_orders.find((r: any) => r.id === id)?.status
const mkReq = (body: any = {}) => ({ json: async () => body }) as any

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any
const seed = () => ({ change_orders: [co({ status: 'countered', line_items: [], subtotal: 100 })], co_attachments: [] })

beforeEach(() => { state.db = {}; state.calls = []; state.cancelBlocked = false; state.cancelThrows = false; state.inFlight = false })

describe('revise (countered): failure and retry leave nothing half-done', () => {
  it('a failed approval lookup removes the revision draft and leaves the original countered (500)', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = seed(); state.cancelThrows = true
    const res = await POST(mkReq({}), ctx('co1'))
    expect(res.status).toBe(500)
    expect(status()).toBe('countered')
    expect(state.db.change_orders).toHaveLength(1)
  })

  it('a stray open draft left by an earlier crash is ADOPTED: the original is superseded and the draft is returned', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = {
      change_orders: [co({ status: 'countered', line_items: [], subtotal: 100 }),
        co({ id: 'stray', status: 'draft', version: 2, root_co_id: 'co1', title: 'edited by the user', projects: undefined })],
      co_attachments: [],
    }
    const res = await POST(mkReq({}), ctx('co1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.coId).toBe('stray')
    expect(status()).toBe('closed')
    expect(state.db.change_orders).toHaveLength(2)
    expect(state.db.change_orders.find((r: any) => r.id === 'stray').title).toBe('edited by the user')
  })

  it('an adopted draft is never deleted when a send is live (409, original stays countered, draft kept)', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = {
      change_orders: [co({ status: 'countered', line_items: [], subtotal: 100 }),
        co({ id: 'stray', status: 'draft', version: 2, root_co_id: 'co1', projects: undefined })],
      co_attachments: [],
    }
    state.cancelBlocked = true
    const res = await POST(mkReq({}), ctx('co1'))
    expect(res.status).toBe(409)
    expect(status()).toBe('countered')
    expect(state.db.change_orders).toHaveLength(2)
  })

  it('an open draft next to a DECLINED original is still just returned (unchanged behaviour)', async () => {
    const { POST } = await import('@/app/api/co/[id]/revise/route')
    state.db = {
      change_orders: [co({ status: 'declined', line_items: [], subtotal: 100 }),
        co({ id: 'd2', status: 'draft', version: 2, root_co_id: 'co1', projects: undefined })],
      co_attachments: [],
    }
    const res = await POST(mkReq({}), ctx('co1'))
    const json = await res.json()
    expect(json).toMatchObject({ coId: 'd2', existing: true })
    expect(status()).toBe('declined')
  })
})
