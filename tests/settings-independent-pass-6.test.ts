// tests/settings-independent-pass-6.test.ts
//
// Settings independent pass 6.
//   B1  settings page tells the client when the billing read failed (Billing tab refuses plan changes)
//   B2  Defaults tab: a late project-type reload cannot land under another type
//   B3  GET /api/workspace/transfer-ownership: a failed read is a 500, not "nobody is eligible"
//   B4  Audit page / client: an incomplete project list does not turn live projects into "Deleted project"
//   B5  reports PDF prints an adjustment's date in the workspace timezone
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

type Op = { name: string; args: any[] }
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(resolver(table, ops)).then(res, rej)
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))

beforeEach(() => {
  session = { id: 'owner', workspaceId: 'w1', name: 'O', email: 'o@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
})

describe('B3 transfer-ownership GET', () => {
  const get = async () => (await import('@/app/api/workspace/transfer-ownership/route')).GET()

  it('lists eligible members when both reads succeed', async () => {
    resolver = (t) => t === 'workspaces'
      ? { data: { created_by: 'owner' }, error: null }
      : { data: [{ user_id: 'u2', effective_permissions: { MANAGE_WORKSPACE_SETTINGS: true }, users: { id: 'u2', name: 'Bo', email: 'b@x.com' } }], error: null }
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).eligibleMembers).toEqual([{ id: 'u2', name: 'Bo', email: 'b@x.com' }])
  })

  it('answers 500 — not an empty list — when the members read fails', async () => {
    resolver = (t) => t === 'workspaces'
      ? { data: { created_by: 'owner' }, error: null }
      : { data: null, error: { message: 'boom' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()).eligibleMembers).toBeUndefined()
  })

  it('answers 500 when the workspace read fails', async () => {
    resolver = () => ({ data: null, error: { message: 'boom' } })
    expect((await get()).status).toBe(500)
  })

  it('still answers an empty list to a non-owner', async () => {
    resolver = () => ({ data: { created_by: 'someone-else' }, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isOwner: false, eligibleMembers: [] })
  })
})

describe('B1 billing load failure flag', () => {
  it('the page reports billing among the failed reads and the client acts on it', () => {
    const page = read('app/(app)/settings/page.tsx')
    expect(page).toMatch(/billing:\s+!!billingRes\.error/)
    const client = read('components/settings/SettingsClient.tsx')
    expect(client).toMatch(/billingLoadFailed=\{!!loadFailed\.billing\}/)
    expect(client).toMatch(/if \(billingLoadFailed\) return/)
    expect(client).toMatch(/disabled=\{!!upgrading \|\| billingLoadFailed\}/)
  })
})

describe('B2 defaults reload race', () => {
  const client = read('components/settings/SettingsClient.tsx')
  it('refetchType is sequence-guarded, marks the editor busy, and treats a failed reload as a failed load', () => {
    const body = client.slice(client.indexOf('async function refetchType()'), client.indexOf('async function saveCurrent()'))
    expect(body).toMatch(/const seq = \+\+loadSeq\.current/)
    expect(body).toMatch(/setTypeLoading\(true\)/)
    expect(body).toMatch(/seq !== loadSeq\.current\) return/)
    expect(body).toMatch(/setTypeData\(null\); setTypeLoadFailed\(true\)/)
  })
  it('a scope change invalidates a reload in flight, and the scope select is locked while saving/loading', () => {
    expect(client).toMatch(/loadSeq\.current\+\+ \/\/ invalidates/)
    expect(client).toMatch(/value=\{scope\} disabled=\{saving \|\| typeLoading\}/)
  })
})

describe('B4 audit list completeness', () => {
  it('page passes completeness flags and the client stops calling unknown projects "Deleted"', () => {
    const page = read('app/(app)/settings/audit/page.tsx')
    expect(page).toMatch(/projectsComplete=\{listState\.projectsComplete\}/)
    expect(page).toMatch(/if \(r\.truncated\) listState\.projectsComplete = false/)
    const client = read('components/settings/AuditLogClient.tsx')
    expect(client).toMatch(/projectsComplete \? 'Deleted project' : 'Project \(name unavailable\)'/)
  })
})

describe('B5 reports PDF date zone', () => {
  it('prints the adjustment date in the workspace timezone, not the server\'s', () => {
    const pdf = read('lib/pdf/reports-report.tsx')
    expect(pdf).toMatch(/fmtDate\(a\.adjusted_at, meta\.timeZone\)/)
    expect(pdf).toMatch(/timeZone: resolveTimeZone\(tz\)/)
  })
  it('a moment just after local midnight in Nairobi is the next day there but still the previous day in UTC', () => {
    const iso = '2026-09-20T21:30:00.000Z' // 00:30 on 21 Sep in Nairobi (UTC+3)
    const fmt = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
    expect(fmt('UTC')).toBe('20 September 2026')
    expect(fmt('Africa/Nairobi')).toBe('21 September 2026')
  })
})
