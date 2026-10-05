// Section 13 (Guardian / scope governance) — independent pass 13 fixes.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { findDuplicateCheck, isFlagBackedMatch } from '@/lib/ai/guardian-pipeline'
import { PROJECT_COMPLETE_CLOSE_PREFIX } from '@/lib/utils/project-status'

const read = (p: string) => readFileSync(p, 'utf-8')

describe('B1: a check only absorbs repeats when its verdict reached the team', () => {
  it('in_scope / covered_by_co need no flag', () => {
    expect(isFlagBackedMatch('in_scope', [])).toBe(true)
    expect(isFlagBackedMatch('covered_by_co', [])).toBe(true)
  })
  it('a flagless out_of_scope / borderline record (retroactive recordOnly) does not match', () => {
    expect(isFlagBackedMatch('out_of_scope', [])).toBe(false)
    expect(isFlagBackedMatch('borderline', [])).toBe(false)
  })
  it('a flag closed by "Mark complete" does not match; a human-closed / resolved / open one does', () => {
    const byCompletion = { status: 'closed', close_reason: `${PROJECT_COMPLETE_CLOSE_PREFIX}Jack` }
    expect(isFlagBackedMatch('out_of_scope', [byCompletion])).toBe(false)
    expect(isFlagBackedMatch('out_of_scope', [{ status: 'closed', close_reason: 'Client withdrew it' }])).toBe(true)
    expect(isFlagBackedMatch('out_of_scope', [{ status: 'closed', close_reason: null }])).toBe(true)
    expect(isFlagBackedMatch('out_of_scope', [{ status: 'open' }])).toBe(true)
    expect(isFlagBackedMatch('borderline', [{ status: 'resolved' }])).toBe(true)
  })

  function fallbackService(recent: any[], flags: any[] | { error: string }) {
    const chain: any = {}
    for (const m of ['select', 'eq', 'not', 'neq', 'or', 'order']) chain[m] = vi.fn(() => chain)
    chain.limit = vi.fn().mockResolvedValue({ data: recent })
    const flagChain: any = { select: vi.fn(() => flagChain) }
    flagChain.in = vi.fn().mockResolvedValue('error' in (flags as any) ? { data: null, error: { message: 'boom' } } : { data: flags, error: null })
    return {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'rpc down' } }),
      from: vi.fn((t: string) => (t === 'guardian_flags' ? flagChain : chain)),
    }
  }
  const vec = [1, 0, 0]

  it('fallback scan skips a flagless out_of_scope match and falls through to null', async () => {
    const svc = fallbackService([{ id: 'c1', embedding: vec, outcome: 'out_of_scope' }], [])
    expect(await findDuplicateCheck(svc as any, 'p1', vec)).toBeNull()
  })
  it('fallback scan prefers a usable match even if a closer one is flagless', async () => {
    const svc = fallbackService([
      { id: 'closer', embedding: [1, 0, 0], outcome: 'out_of_scope' },
      { id: 'ok', embedding: [1, 0.2, 0], outcome: 'in_scope' },
    ], [])
    expect(await findDuplicateCheck(svc as any, 'p1', [1, 0, 0])).toBe('ok')
  })
  it('fallback scan matches a flagged out_of_scope check, and fails toward classifying if the flag lookup errors', async () => {
    const withFlag = fallbackService([{ id: 'c1', embedding: vec, outcome: 'out_of_scope' }], [{ check_id: 'c1', status: 'open', close_reason: null }])
    expect(await findDuplicateCheck(withFlag as any, 'p1', vec)).toBe('c1')
    const flagErr = fallbackService([{ id: 'c1', embedding: vec, outcome: 'out_of_scope' }], { error: 'x' })
    expect(await findDuplicateCheck(flagErr as any, 'p1', vec)).toBeNull()
  })

  it('migration 147 adds the flag probe, keeps the 144 rules and the service-role-only grants', () => {
    const sql = read('supabase/migrations/147_guardian_dedup_requires_flag.sql')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.guardian_find_duplicate_check')
    expect(sql).toContain('COALESCE(c.classified_at, c.created_at) >= p_since')
    expect(sql).toContain("c.outcome NOT IN ('out_of_scope', 'borderline')")
    expect(sql).toContain('f.check_id = c.id')
    expect(sql).toContain(`LIKE '${PROJECT_COMPLETE_CLOSE_PREFIX}%'`)
    expect(sql).toContain('TO service_role')
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*(anon|authenticated|PUBLIC)/)
  })
  it('the complete route writes the shared prefix', () => {
    expect(read('app/api/projects/[id]/complete/route.ts')).toContain('`${PROJECT_COMPLETE_CLOSE_PREFIX}${session.name}`')
  })
})

describe('B2: draft_co never returns raw database text', () => {
  it('the 500 is generic and the real message is only logged', () => {
    const src = read('app/api/guardian/flags/[id]/route.ts')
    expect(src).not.toContain('coErr?.message ||')
    expect(src).toContain("console.error('Guardian draft_co: change order insert failed:', coErr?.message)")
  })
})
