import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// CO logic (c10), independent pass 8.
//  B1  A failed database read answered "not found" (404) on every CO route; only PGRST116 / 22P02 are real not-founds.
//  B2  A failed sibling-version read (revise, exception, send) skipped the one-live-version guards instead of stopping.
//  B3  An edit that landed after a send-for-approval was created could be auto-sent at an amount nobody approved.
//  B4  Flag re-claim (revise) and flag resolution (exception) ignored / never retried a failed write.
//  B5  CoEditor autosaves could reach the server out of order, and a failed attachment load read as "None yet".

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── B1 ────────────────────────────────────────────────────────────────────────────────────────────────────
import { isRealLookupFailure, lookupMissResponse } from '@/lib/documents/co-lookup'

describe('B1 lookup failures are not "not found"', () => {
  it('treats no-rows and a malformed id as genuine not-founds, everything else as a failure', () => {
    expect(isRealLookupFailure(null)).toBe(false)
    expect(isRealLookupFailure(undefined)).toBe(false)
    expect(isRealLookupFailure({ code: 'PGRST116', message: 'no rows' })).toBe(false)
    expect(isRealLookupFailure({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe(false)
    expect(isRealLookupFailure({ code: '57014', message: 'statement timeout' })).toBe(true)
    expect(isRealLookupFailure({ code: 'PGRST201', message: 'more than one relationship' })).toBe(true)
    expect(isRealLookupFailure({ message: 'fetch failed' })).toBe(true)
  })
  it('answers 404 for a miss and 500 for a failed read', async () => {
    const miss = lookupMissResponse({ code: 'PGRST116' }, 'Not found')
    expect(miss.status).toBe(404)
    expect((await miss.json()).error).toBe('Not found')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = lookupMissResponse({ code: '57014', message: 'timeout' }, 'Not found')
    expect(failed.status).toBe(500)
    expect((await failed.json()).error).toMatch(/try again/i)
    spy.mockRestore()
  })
  it('every CO route that looks a change order up goes through the helper', () => {
    const routes = [
      'app/api/co/[id]/route.ts', 'app/api/co/[id]/close/route.ts', 'app/api/co/[id]/withdraw/route.ts',
      'app/api/co/[id]/accept-counter/route.ts', 'app/api/co/[id]/escalate/route.ts', 'app/api/co/[id]/remind/route.ts',
      'app/api/co/[id]/link/route.ts', 'app/api/co/[id]/revise/route.ts', 'app/api/co/[id]/exception/route.ts',
      'app/api/co/[id]/attachments/route.ts', 'app/api/co/[id]/attachments/[attachmentId]/route.ts', 'app/api/pdf/co/[id]/route.ts',
    ]
    for (const r of routes) {
      const src = read(r)
      expect(src, r).toMatch(/lookupMissResponse\(coLookupErr/)
      expect(src, r).not.toMatch(/if \(!co\) return NextResponse\.json/)
    }
    expect(read('app/api/co/[id]/send/route.ts')).toMatch(/isRealLookupFailure\(coFetchErr\)/)
  })
})

describe('B1 GET /api/co/[id] route', () => {
  let lookup: { data: any; error: any }
  beforeEach(() => { vi.resetModules(); lookup = { data: null, error: null } })

  async function callGet() {
    vi.doMock('@/lib/supabase/server', () => ({
      createServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => lookup }) }) }) }) }),
    }))
    vi.doMock('@/lib/auth/session', () => ({
      getSession: async () => ({ id: 'u1', workspaceId: 'w1', email: 'a@x.co', name: 'A', permissions: [] }),
      hasPermission: () => true,
    }))
    vi.doMock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
    vi.doMock('@/lib/approvals/engine', () => ({ getPendingApprovalForDocument: async () => null }))
    const { GET } = await import('@/app/api/co/[id]/route')
    return GET({} as any, { params: Promise.resolve({ id: 'c1' }) })
  }

  it('returns 404 when there is genuinely no such change order', async () => {
    lookup = { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    expect((await callGet()).status).toBe(404)
  })
  it('returns 500, not 404, when the read itself failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    lookup = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    expect((await callGet()).status).toBe(500)
    spy.mockRestore()
  })
})

// ── B2 ────────────────────────────────────────────────────────────────────────────────────────────────────
import { liveCoSiblingMessage } from '@/lib/documents/co-live-sibling'

describe('B2 a failed sibling read blocks instead of passing', () => {
  const svc = (result: any) => ({
    from: () => ({ select: () => ({ or: () => ({ neq: () => ({ in: () => ({ limit: async () => result }) }) }) }) }),
  })
  it('send guard: a failed lookup refuses the send with a retryable message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msg = await liveCoSiblingMessage(svc({ data: null, error: { message: 'boom' } }), { id: 'c1', root_co_id: null })
    expect(msg).toMatch(/try again/i)
    spy.mockRestore()
  })
  it('still allows the send when the lookup works and finds nothing, and blocks when it finds a live one', async () => {
    expect(await liveCoSiblingMessage(svc({ data: [], error: null }), { id: 'c1' })).toBeNull()
    const msg = await liveCoSiblingMessage(svc({ data: [{ id: 'c0', version: 1, status: 'awaiting_response' }], error: null }), { id: 'c1' })
    expect(msg).toMatch(/Version 1 .* still open/)
  })
  it('revise and exception stop on a failed sibling read', () => {
    expect(read('app/api/co/[id]/revise/route.ts')).toMatch(/if \(siblingsErr\) throw new Error/)
    expect(read('app/api/co/[id]/exception/route.ts')).toMatch(/if \(siblingsErr\) throw new Error/)
  })
})

// ── B3 ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B3 auto-send refuses a change order that changed size after approval was requested', () => {
  function fakeService(co: any) {
    const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: co, error: null }), limit: () => chain, maybeSingle: async () => ({ data: null, error: null }) }
    return { from: () => chain }
  }
  const co = (total: number, extra: any = {}) => ({
    id: 'c1', title: 'T', status: 'draft', note: null, total, version: 1, document_number: null, root_co_id: null, project_id: 'p1',
    is_retainer_renewal: false, renewal_term_months: null, is_credit: false,
    line_items: [{ id: 'l1', description: 'Work', quantity: 1, rate: total, total }], ...extra,
    projects: { id: 'p1', name: 'P', status: 'Active', currency: 'USD', type: 'fixed', retainer_duration_months: null, client_id: 'cl1', deleted_at: null,
      clients: { name: 'C', email: 'c@x.co', cc_emails: [] }, workspaces: { id: 'w1', agency_name: 'Ag', brand_colour: '#000' } },
  })
  const params = { coId: 'c1', workspaceId: 'w1', actorId: 'u1', actorEmail: 'a@x.co', actorName: 'A' }

  it('refuses with a clear 409 when the amount no longer matches what was approved', async () => {
    const { sendCoDocument } = await import('@/lib/documents/send-co')
    const r = await sendCoDocument(fakeService(co(50000)), { ...params, approvedGateAmount: 5000 })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(409); expect(r.error).toMatch(/edited after it was submitted for approval/) }
  })
  it('does not trip when the amount matches (or a credit is compared by size)', async () => {
    const { sendCoDocument } = await import('@/lib/documents/send-co')
    // A matching amount gets past the guard and stops at the NEXT check (no signed SOW in the fake) - not at the guard.
    const ok = await sendCoDocument(fakeService(co(5000)), { ...params, approvedGateAmount: 5000 })
    expect(ok.ok).toBe(false)
    if (!ok.ok) expect(ok.error).toMatch(/no signed SOW/)
    const credit = await sendCoDocument(fakeService(co(-300, { is_credit: true, line_items: [{ id: 'l1', description: 'Removed', quantity: 1, rate: -300, total: -300 }] })), { ...params, approvedGateAmount: 300 })
    if (!credit.ok) expect(credit.error).not.toMatch(/edited after/)
  })
  it('a retainer renewal is compared on the same scaled amount the gate used', async () => {
    const { sendCoDocument } = await import('@/lib/documents/send-co')
    const renewal = co(2000, { is_retainer_renewal: true, renewal_term_months: 12 })
    renewal.projects.type = 'retainer'; renewal.projects.retainer_duration_months = 12
    const r = await sendCoDocument(fakeService(renewal), { ...params, approvedGateAmount: 24000 })
    if (!r.ok) expect(r.error).not.toMatch(/edited after/)
  })
  it('the approval engine hands the approved amount to the CO send', () => {
    expect(read('lib/approvals/engine.ts')).toMatch(/sendCoDocument\(service, \{[^}]*approvedGateAmount: request\.context\?\.amount/)
  })
})

// ── B4 ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B4 flag writes are checked and retried', () => {
  it('revise re-claims the flag with a checked, retried write', () => {
    const src = read('app/api/co/[id]/revise/route.ts')
    expect(src).toMatch(/for \(let attempt = 0; attempt < 2; attempt\+\+\)[\s\S]{0,400}status: 'converted_to_co', change_order_id: revision\.id/)
    expect(src).toMatch(/could not re-claim the linked flag/)
  })
  it('exception retries the flag resolution once', () => {
    const src = read('app/api/co/[id]/exception/route.ts')
    expect(src).toMatch(/for \(let attempt = 0; attempt < 2; attempt\+\+\)[\s\S]{0,500}resolution: 'exception'/)
  })
})

// ── B5 ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B5 CoEditor', () => {
  const src = read('components/co/CoEditor.tsx')
  it('serialises saves so an older request cannot land after a newer one', () => {
    expect(src).toMatch(/const saveQueue = useRef<Promise<unknown>>\(Promise\.resolve\(\)\)/)
    expect(src).toMatch(/saveQueue\.current\.catch\(\(\) => \{\}\)\.then\(\(\) => doSaveNow\(explicit, navigate\)\)/)
    expect(src).toMatch(/async function doSaveNow\(/)
  })
  it('does not render a failed attachment load as an empty list', () => {
    expect(src).toMatch(/if \(!res\.ok\) \{ if \(mounted\.current\) setError\(json\.error \|\| 'Could not load attachments'\)/)
  })
})
