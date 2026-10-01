import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type TableResult = { data: any[] | null; error: { message: string } | null }
let tables: Record<string, TableResult> = {}
let session: any

function builder(table: string) {
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const res = tables[table] || { data: [], error: null }
        return (resolve: any) => resolve(res)
      }
      return () => chain
    },
  })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => session,
  hasPermission: (s: any, p: string) => !!s?.perms?.includes(p),
}))

import { GET } from '@/app/api/search/route'

const req = (q: string) => ({ url: `http://x.test/api/search?q=${encodeURIComponent(q)}` }) as any
const ALL = ['VIEW_ALL_PROJECTS', 'VIEW_CLIENT_DATA', 'VIEW_FINANCIALS']

beforeEach(() => {
  tables = {}
  session = { id: 'u-' + Math.random(), workspaceId: 'w1', perms: ALL }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Search round 6 — result lines use the app\'s status labels, not raw database values', () => {
  it('SOW shows "Sent" for awaiting_signature', async () => {
    tables.sow_documents = { data: [{ id: 's1', document_number: 'SOW-0010', status: 'awaiting_signature', version: 2, project_id: 'p9', projects: { name: 'Acme Rebrand' } }], error: null }
    const json = await (await GET(req('rebrand'))).json()
    expect(json.results.find((r: any) => r.type === 'sow').sub).toBe('v2 · Sent')
  })

  it('change order shows "Sent" for awaiting_response and "Awaiting Countersignature" for awaiting_countersignature', async () => {
    tables.change_orders = { data: [
      { id: 'c1', title: 'Extra pages', document_number: 'CO-1', status: 'awaiting_response', project_id: 'p9', projects: { name: 'Acme Rebrand' } },
      { id: 'c2', title: 'Extra pages 2', document_number: 'CO-2', status: 'awaiting_countersignature', project_id: 'p9', projects: { name: 'Acme Rebrand' } },
    ], error: null }
    const json = await (await GET(req('extra pages'))).json()
    const subs = Object.fromEntries(json.results.filter((r: any) => r.type === 'change_order').map((r: any) => [r.id, r.sub]))
    expect(subs.c1).toBe('Acme Rebrand · CO · Sent')
    expect(subs.c2).toBe('Acme Rebrand · CO · Awaiting Countersignature')
  })

  it('invoice shows "Partially paid" for partially_paid', async () => {
    tables.invoices = { data: [{ id: 'i1', title: 'Milestone 2', invoice_number: 'INV-7', status: 'partially_paid', project_id: 'p9', projects: { name: 'Acme Rebrand' } }], error: null }
    const json = await (await GET(req('milestone'))).json()
    expect(json.results.find((r: any) => r.type === 'invoice').sub).toBe('Acme Rebrand · Invoice · Partially paid')
  })

  it('flag shows "CO Created" for converted_to_co', async () => {
    tables.guardian_flags = { data: [{ id: 'f1', description: 'Extra homepage variants requested', sow_reference: '§2', severity: 'high', status: 'converted_to_co', project_id: 'p9', projects: { name: 'Acme Rebrand' } }], error: null }
    const json = await (await GET(req('homepage'))).json()
    expect(json.results.find((r: any) => r.type === 'guardian_flag').sub).toBe('Acme Rebrand · high severity · CO Created')
  })

  it('an unknown future status still renders readably', async () => {
    tables.invoices = { data: [{ id: 'i2', title: 'Retainer', invoice_number: null, status: 'pending_review', project_id: 'p9', projects: { name: 'Acme' } }], error: null }
    const json = await (await GET(req('retainer'))).json()
    expect(json.results.find((r: any) => r.type === 'invoice').sub).toBe('Acme · Invoice · pending review')
  })
})

describe('Search round 6 — Team page follows ?highlight= from any tab (source checks)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('a new ?highlight= switches to the Members tab before the scroll/flash effect needs it', () => {
    const src = read('components/team/TeamClient.tsx')
    expect(src).toMatch(/useEffect\(\(\) => \{ if \(highlightId\) setTab\('members'\) \}, \[highlightId\]\)/)
    // the scroll/flash effect still re-runs when the derived tab changes
    expect(src).toMatch(/\}, \[highlightId, tab\]\)/)
  })

  it('the search route no longer prints raw status values', () => {
    const src = read('app/api/search/route.ts')
    expect(src).not.toMatch(/\$\{s\.status\}/)
    expect(src).not.toMatch(/\$\{co\.status\}/)
    expect(src).not.toMatch(/\$\{inv\.status\}/)
    expect(src).not.toMatch(/String\(f\.status\)\.replace/)
  })
})
