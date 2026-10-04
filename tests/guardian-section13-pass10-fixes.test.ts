// Section 13 (Guardian / scope governance) — independent pass 10 fixes.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dedupSinceIso, findDuplicateCheck, DEDUP_WINDOW_DAYS } from '@/lib/ai/guardian-pipeline'
import { claimAiRateSlotByProject } from '@/lib/utils/rate-limit'

const read = (p: string) => readFileSync(p, 'utf-8')
const DAY = 86400000

describe('B1: duplicate window starts at the last scope change', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z')

  it('is the flat 30-day window when the scope never changed or the date is unusable', () => {
    const expected = new Date(now - DEDUP_WINDOW_DAYS * DAY).toISOString()
    expect(dedupSinceIso(now)).toBe(expected)
    expect(dedupSinceIso(now, null)).toBe(expected)
    expect(dedupSinceIso(now, 'not a date')).toBe(expected)
  })

  it('ignores a scope change older than the window', () => {
    expect(dedupSinceIso(now, '2026-01-01T00:00:00+00:00')).toBe(new Date(now - DEDUP_WINDOW_DAYS * DAY).toISOString())
  })

  it('moves the start up to a scope change inside the window (PostgREST offset format)', () => {
    expect(dedupSinceIso(now, '2026-10-10T08:30:00.123456+00:00')).toBe('2026-10-10T08:30:00.123Z')
  })

  it('findDuplicateCheck sends that start to the RPC and to the fallback scan', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    await findDuplicateCheck({ rpc } as any, 'p1', [0.1, 0.2], new Date(Date.now() - 2 * DAY).toISOString())
    const since = Date.parse(rpc.mock.calls[0][1].p_since)
    expect(Math.abs(since - (Date.now() - 2 * DAY))).toBeLessThan(5000)

    const gte = vi.fn()
    const chain: any = {}
    for (const m of ['select', 'eq', 'not', 'neq', 'order']) chain[m] = vi.fn(() => chain)
    chain.gte = gte.mockImplementation(() => chain)
    chain.limit = vi.fn().mockResolvedValue({ data: [] })
    const service = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }), from: vi.fn(() => chain) }
    await findDuplicateCheck(service as any, 'p1', [0.1, 0.2], new Date(Date.now() - 2 * DAY).toISOString())
    expect(Math.abs(Date.parse(gte.mock.calls[0][1]) - (Date.now() - 2 * DAY))).toBeLessThan(5000)
  })

  it('every caller reads and passes the snapshot timestamp', () => {
    for (const f of ['app/api/guardian/check/route.ts', 'app/api/guardian/inbound/route.ts']) {
      const src = read(f)
      expect(src).toContain('out_of_scope, last_updated_at)')
      expect(src).toContain('.last_updated_at) : null')
    }
    const pipe = read('lib/ai/guardian-pipeline.ts')
    expect(pipe).toContain('out_of_scope, last_updated_at)')
    expect(pipe).toContain('findDuplicateCheck(service, check.project_id, embedding, snapshot.last_updated_at)')
  })
})

describe('B2: Guardian AI rate limits claim atomically before the paid call', () => {
  it('check route claims the slot before the embedding and no longer records afterwards', () => {
    const src = read('app/api/guardian/check/route.ts')
    expect(src).toContain('claimAiRateSlot(service, session.workspaceId, session.id')
    expect(src).not.toContain('recordAiUsage(')
    expect(src.indexOf('claimAiRateSlot(service')).toBeLessThan(src.indexOf('await tryEmbedding('))
  })

  it('inbound claims the slot before the embedding and no longer records afterwards', () => {
    const src = read('app/api/guardian/inbound/route.ts')
    expect(src).toContain('claimAiRateSlotByProject(service, project.workspace_id, project.id')
    expect(src).not.toContain('recordAiUsageByProject(')
    expect(src.indexOf('claimAiRateSlotByProject(')).toBeLessThan(src.indexOf('await tryEmbedding('))
  })

  function fakeLog(existing: number) {
    const rows: Array<{ id: string }> = Array.from({ length: existing }, (_, i) => ({ id: `old${i}` }))
    const deleted: string[] = []
    const service = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => { const r = { id: 'mine' }; rows.push(r); return { data: r, error: null } } }) }),
        select: () => { const q: any = { eq: () => q, gte: async () => ({ count: rows.length, error: null }) }; return q },
        delete: () => ({ eq: async (_c: string, id: string) => { deleted.push(id); return { error: null } } }),
      }),
    }
    return { service, deleted }
  }

  it('allows a claim that fits and refuses (and withdraws) one past the limit', async () => {
    const ok = fakeLog(28) // limit for guardian.inbound is 30 per window; this claim is the 29th
    expect((await claimAiRateSlotByProject(ok.service, 'w', 'p', 'guardian.inbound')).allowed).toBe(true)
    expect(ok.deleted).toEqual([])

    const full = fakeLog(30) // this claim would be the 31st
    const res = await claimAiRateSlotByProject(full.service, 'w', 'p', 'guardian.inbound')
    expect(res.allowed).toBe(false)
    expect(res.message).toContain('inbound checks')
    expect(full.deleted).toEqual(['mine'])
  })

  it('fails open when the claim insert errors', async () => {
    const service = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }
    expect((await claimAiRateSlotByProject(service, 'w', 'p', 'guardian.inbound')).allowed).toBe(true)
  })
})

describe('B3: scope-adjustment checks its cleanup delete', () => {
  it('reads the delete error and retries before giving up loudly', () => {
    const src = read('app/api/guardian/scope-adjustment/route.ts')
    const block = src.slice(src.indexOf('if (snapErr || !updatedSnap'), src.indexOf('await logAudit'))
    expect(block).toContain('cleanupErr')
    expect(block).toContain('attempt < 3')
    expect(block).toContain('ORPHANED scope_adjustments row')
    expect(block.indexOf('cleanupErr')).toBeLessThan(block.indexOf('return NextResponse.json'))
  })
})
