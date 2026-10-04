// Section 13 (Guardian / scope governance) — independent pass 11 fixes.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { findDuplicateCheck } from '@/lib/ai/guardian-pipeline'

const read = (p: string) => readFileSync(p, 'utf-8')

describe('B1: duplicate window is measured from when a check was judged', () => {
  it('the fallback scan filters on classified_at (created_at only for never-classified rows), not created_at alone', async () => {
    const orFilter = vi.fn()
    const gte = vi.fn()
    const chain: any = {}
    for (const m of ['select', 'eq', 'not', 'neq', 'order']) chain[m] = vi.fn(() => chain)
    chain.or = orFilter.mockImplementation(() => chain)
    chain.gte = gte.mockImplementation(() => chain)
    chain.limit = vi.fn().mockResolvedValue({ data: [] })
    const service = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }), from: vi.fn(() => chain) }
    await findDuplicateCheck(service as any, 'p1', [0.1, 0.2], '2026-10-10T00:00:00.000Z')
    expect(gte).not.toHaveBeenCalled()
    const f: string = orFilter.mock.calls[0][0]
    expect(f).toMatch(/classified_at\.gte\./)
    expect(f).toMatch(/and\(classified_at\.is\.null,created_at\.gte\./)
  })

  it('a backlog row created before a re-sign but classified after it is matched by the window rule', () => {
    // Mirrors COALESCE(classified_at, created_at) >= p_since from migration 144.
    const since = Date.parse('2026-10-10T12:00:00Z')            // snapshot last_updated_at (signing)
    const inWindow = (r: { created: string; classified?: string }) =>
      Date.parse(r.classified ?? r.created) >= since
    expect(inWindow({ created: '2026-10-09T08:00:00Z', classified: '2026-10-10T12:20:00Z' })).toBe(true)   // backlog, swept after signing
    expect(inWindow({ created: '2026-10-09T08:00:00Z', classified: '2026-10-09T08:00:05Z' })).toBe(false)  // judged against the old scope
    expect(inWindow({ created: '2026-10-11T08:00:00Z' })).toBe(true)
  })

  it('migration 144 redefines the lookup on COALESCE(classified_at, created_at) and keeps the service-role-only grants', () => {
    const files = readdirSync('supabase/migrations').filter(f => f.startsWith('144_'))
    expect(files).toHaveLength(1)
    const sql = read(`supabase/migrations/${files[0]}`)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.guardian_find_duplicate_check')
    expect(sql).toContain('COALESCE(c.classified_at, c.created_at) >= p_since')
    expect(sql).toContain("c.outcome NOT IN ('pending')")
    expect(sql).toContain('TO service_role')
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*(anon|authenticated|PUBLIC)/)
  })
})

describe("B2: source 'email' is reserved for the inbound webhook", () => {
  it('the session check route no longer accepts email', () => {
    const src = read('app/api/guardian/check/route.ts')
    expect(src).toContain("const SOURCES = ['paste', 'slack', 'webhook']")
    expect(src).toContain("neq('source', 'email')")
  })

  it('inbound still writes source email itself', () => {
    expect(read('app/api/guardian/inbound/route.ts')).toContain("source: 'email'")
  })

  it('the UI only ever submits paste', () => {
    expect(read('components/projects/ProjectDetail.tsx')).toContain("source: 'paste'")
  })
})
