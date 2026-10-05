import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'
import { getContractValueBefore } from '@/lib/documents/co-contract-value'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const amend = (o: Record<string, any>) => ({ project_id: 'p1', financial_impact: 0, created_at: '2026-01-01T00:00:00Z', change_orders: { is_retainer_renewal: false }, ...o })

describe('CO-1: getContractValueBefore uses the app-wide contract definition', () => {
  const retainer = { type: 'retainer', retainer_duration_months: 12 }

  it('a fixed-term retainer starts from monthly rate x term, not one month', async () => {
    const { client } = createFakeSupabase({ amendments: [] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 2000, { project: retainer })
    expect(v).toBe(24000)
  })

  it('adds other accepted amendments but ignores retainer-renewal amendments on a retainer', async () => {
    const { client } = createFakeSupabase({ amendments: [
      amend({ change_order_id: 'a', financial_impact: 1000 }),
      amend({ change_order_id: 'r', financial_impact: 3000, change_orders: { is_retainer_renewal: true } }),
    ] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 2000, { project: retainer })
    expect(v).toBe(25000)
  })

  it('a non-retainer project is base + amendments, unchanged', async () => {
    const { client } = createFakeSupabase({ amendments: [amend({ change_order_id: 'a', financial_impact: 500 })] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 10000, { project: { type: 'fixed' } })
    expect(v).toBe(10500)
  })

  it('never goes below zero after large credits', async () => {
    const { client } = createFakeSupabase({ amendments: [amend({ change_order_id: 'a', financial_impact: -50000 })] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 10000, { project: { type: 'fixed' } })
    expect(v).toBe(0)
  })

  it('a pending retainer renewal still reports the current monthly rate', async () => {
    const { client } = createFakeSupabase({ amendments: [amend({ change_order_id: 'a', financial_impact: 500 })] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 2000, { isRenewal: true, project: retainer })
    expect(v).toBe(2000)
  })

  it('an accepted CO only counts amendments created before its own', async () => {
    const { client } = createFakeSupabase({ amendments: [
      amend({ change_order_id: 'co1', financial_impact: 700, created_at: '2026-03-01T00:00:00Z' }),
      amend({ change_order_id: 'early', financial_impact: 100, created_at: '2026-02-01T00:00:00Z' }),
      amend({ change_order_id: 'late', financial_impact: 9999, created_at: '2026-04-01T00:00:00Z' }),
    ] })
    const v = await getContractValueBefore(client, 'p1', 'co1', 1000, { project: { type: 'fixed' } })
    expect(v).toBe(1100)
  })

  it('every caller passes the project shape and selects retainer_duration_months', () => {
    for (const f of ['app/api/pdf/co/[id]/route.ts', 'app/api/portal/co/[token]/pdf/route.ts']) {
      const src = read(f)
      expect(src).toMatch(/retainer_duration_months/)
      expect(src).toMatch(/getContractValueBefore\([\s\S]*?project/)
    }
    for (const f of ['app/api/portal/co/[token]/accept/route.ts', 'app/api/portal/co/[token]/countersign/route.ts'])
      expect(read(f)).toMatch(/contract_value,retainer_duration_months/)
    expect(read('lib/documents/finalize-co.ts')).toMatch(/\{ project \}\)/)
  })
})

describe('CO-2: revising a countered CO', () => {
  const src = read('app/api/co/[id]/revise/route.ts')
  it('requires SEND_CHANGE_ORDERS when the original is countered, before anything is written', () => {
    const permAt = src.indexOf("co.status === 'countered' && !hasPermission(session, 'SEND_CHANGE_ORDERS')")
    expect(permAt).toBeGreaterThan(-1)
    expect(permAt).toBeLessThan(src.indexOf('insertNextCoVersion(service'))
  })
  it('does not email the client from an unverified member', () => {
    expect(src).toMatch(/client\?\.email && !session\.emailVerifiedAt\) clientNotified = false/)
  })
  it('the Counter back button matches the server permission', () => {
    expect(read('components/projects/ProjectDetail.tsx')).toMatch(/co\.status === 'countered' && permissions\.createCo && permissions\.sendCo/)
  })
})

describe('CO-3: withdraw guards on the status it read', () => {
  it("CAS is .eq('status', co.status), not the whole withdrawable list", () => {
    const src = read('app/api/co/[id]/withdraw/route.ts')
    const upd = src.slice(src.indexOf(".update({ status: 'withdrawn'"), src.indexOf('withdrawnCo || withdrawnCo.length'))
    expect(upd).toMatch(/\.eq\('status', co\.status\)/)
    expect(upd).not.toMatch(/\.in\('status'/)
  })
})

describe('CO-4: CoEditor after a failed load', () => {
  const src = read('components/co/CoEditor.tsx')
  it('locks the form and stops autosave', () => {
    expect(src).toMatch(/const \[loadFailed, setLoadFailed\]/)
    expect(src).toMatch(/const isLocked = [^\n]*loadFailed/)
    expect(src).toMatch(/if \(loadFailed \|\| pendingApproval/)
    expect(src).toMatch(/\[snapshot, saveTick, pendingApproval, status, loading, loadFailed, canEdit\]/)
  })
  it('flags both a non-OK response and a network error, and does not show the "sent" banner', () => {
    expect(src).toMatch(/if \(!r\.ok\) \{ setLoadFailed\(true\)/)
    expect(src).toMatch(/\.catch\(\(\) => \{ setLoadFailed\(true\)/)
    expect(src).toMatch(/isLocked && !loadFailed/)
  })
})

describe('CO-5: create route and pricing without VIEW_FINANCIALS', () => {
  it('refuses priced lines or a credit, but not an unpriced shell, before touching the database', () => {
    const src = read('app/api/co/route.ts')
    const at = src.indexOf("!hasPermission(session, 'VIEW_FINANCIALS')")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('createServiceClient()'))
    expect(src).toMatch(/Number\(l\?\.rate\) > 0/)
  })
})
