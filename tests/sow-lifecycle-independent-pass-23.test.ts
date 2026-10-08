import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { claimAiRateSlot } from '@/lib/utils/rate-limit'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// B1 — AI routes claim their rate slot atomically before the first paid call.
describe('B1 — SOW AI routes claim the rate slot before the model call', () => {
  const routes: Array<[string, string]> = [
    ['app/api/sow/generate/route.ts', 'sow.generate'],
    ['app/api/sow/regenerate-section/route.ts', 'sow.regenerateSection'],
    ['app/api/sow/parse-brief/route.ts', 'sow.parseBrief'],
    ['app/api/invoices/draft/route.ts', 'invoice.draft'],
  ]
  for (const [file, key] of routes) {
    it(`${file} claims '${key}' first and no longer uses check-then-record`, () => {
      const src = read(file)
      expect(src).not.toContain('checkAiRateLimit')
      const claim = src.indexOf(`claimAiRateSlot(service, session.workspaceId, session.id, '${key}')`)
      expect(claim).toBeGreaterThan(-1)
      const call = Math.min(...['messages.create', 'createWithTool('].map(t => src.indexOf(t)).filter(i => i > -1))
      expect(claim).toBeLessThan(call)
    })
  }
  it('generate counts every retry attempt beyond the claimed first', () => {
    const src = read('app/api/sow/generate/route.ts')
    expect(src).toContain("if (attempt > 1) await recordAiUsage(")
  })
  it('regenerate-section / parse-brief / invoice draft no longer record after the call', () => {
    for (const f of ['app/api/sow/regenerate-section/route.ts', 'app/api/sow/parse-brief/route.ts', 'app/api/invoices/draft/route.ts'])
      expect(read(f)).not.toContain('recordAiUsage(')
  })
})

describe('B1 — a parallel burst cannot exceed the limit', () => {
  it('only `max` of N simultaneous claims are allowed', async () => {
    const rows: Array<{ id: number }> = []
    let next = 1
    const service: any = {
      from: () => {
        const q: any = {
          insert: () => { const r = { id: next++ }; rows.push(r); q._row = r; return q },
          select: (_c?: string, o?: any) => { q._head = !!o?.head; return q },
          single: async () => ({ data: q._row, error: null }),
          eq: () => q, gte: () => q,
          delete: () => ({ eq: async (_: string, id: number) => { const i = rows.findIndex(r => r.id === id); if (i > -1) rows.splice(i, 1); return { error: null } } }),
          then: (res: any) => res({ count: rows.length, error: null }),
        }
        return q
      },
    }
    const results = await Promise.all(Array.from({ length: 40 }, () => claimAiRateSlot(service, 'w', 'u', 'sow.generate')))
    expect(results.filter(r => r.allowed).length).toBeLessThanOrEqual(10)
  })
})

describe('B2/B3 — read and write errors are not swallowed', () => {
  it('generate reads the existing draft with maybeSingle and fails on error', () => {
    const src = read('app/api/sow/generate/route.ts')
    expect(src).toContain('existingSowErr')
    expect(src).toContain("throw new Error(`draft read failed")
  })
  it('send-sow logs a failed project status move', () => {
    expect(read('lib/documents/send-sow.ts')).toContain('projStatusErr')
  })
})
