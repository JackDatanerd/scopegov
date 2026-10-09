import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { findSignedSow, SIGNED_SOW_LOOKUP_FAILED } from '@/lib/documents/signed-sow'
import { checkReminderCooldown } from '@/lib/utils/reminder-cooldown'
import { computeCoTotals } from '@/lib/documents/co-totals'

// CO logic (c10), independent pass 10 - failed reads reported as business answers, quantity coercion, PDF parity.
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// A chainable fake of the supabase-js query builder: every method returns itself, awaiting it yields `result`.
function fake(results: Record<string, { data: any; error: any } | Array<{ data: any; error: any }>>) {
  const calls: Record<string, number> = {}
  const builder = (table: string): any => {
    const b: any = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (res: any) => {
          const r = results[table]
          const out = Array.isArray(r) ? (r[calls[table] = (calls[table] ?? -1) + 1] ?? { data: null, error: null }) : (r ?? { data: null, error: null })
          return res(out)
        }
        return () => b
      },
    })
    return b
  }
  return { from: builder }
}

describe('B1 signed-SOW lookup distinguishes "none" from "failed"', () => {
  it('returns the signed SOW', async () => {
    const r = await findSignedSow(fake({ sow_documents: { data: { id: 's1', document_number: 'SOW-1' }, error: null } }), 'p', { newest: true })
    expect(r).toEqual({ ok: true, sow: { id: 's1', document_number: 'SOW-1', lateFeeRate: null } })
  })
  it('carries the late fee the SOW froze at drafting', async () => {
    const r = await findSignedSow(fake({ sow_documents: { data: { id: 's1', document_number: 'SOW-1', metadata: { lateFeeRate: 1.5 } }, error: null } }), 'p', { newest: true })
    expect(r).toEqual({ ok: true, sow: { id: 's1', document_number: 'SOW-1', lateFeeRate: 1.5 } })
  })
  it('returns sow:null when there genuinely is none', async () => {
    expect(await findSignedSow(fake({ sow_documents: { data: null, error: null } }), 'p')).toEqual({ ok: true, sow: null })
  })
  it('returns ok:false on a failed read instead of reading it as "none"', async () => {
    const r = await findSignedSow(fake({ sow_documents: { data: null, error: { message: 'boom' } } }), 'p')
    expect(r.ok).toBe(false)
  })
  it.each([
    'app/api/co/route.ts', 'app/api/co/[id]/send/route.ts', 'lib/documents/send-co.ts', 'lib/documents/finalize-co.ts',
  ])('%s uses the shared lookup and no longer queries sow_documents directly', (file) => {
    const src = read(file)
    expect(src).toMatch(/findSignedSow\(/)
    expect(src).toMatch(/sowLookup\.ok/)
    expect(src).not.toMatch(/from\('sow_documents'\)/)
  })
  it('finalize-co answers a failed lookup with a 500 before the status CAS', () => {
    const src = read('lib/documents/finalize-co.ts')
    expect(src).toMatch(/!sowLookup\.ok\) return \{ ok: false as const, error: SIGNED_SOW_LOOKUP_FAILED, status: 500 \}/)
    expect(src.indexOf('findSignedSow(service')).toBeLessThan(src.indexOf('const casUpdate'))
  })
  it('has a user-facing message', () => expect(SIGNED_SOW_LOOKUP_FAILED).toMatch(/try again/))
})

describe('B2 / B3 escalate and create route fail loudly on a failed read', () => {
  it('escalate throws on a failed assignee lookup and asks for a strict project-access check', () => {
    const src = read('app/api/co/[id]/escalate/route.ts')
    expect(src).toMatch(/memberErr && isRealLookupFailure\(memberErr\)\) throw/)
    expect(src).toMatch(/\{ strict: true \}/)
  })
  it('POST /api/co throws on a failed flag lookup', () => {
    expect(read('app/api/co/route.ts')).toMatch(/flagErr && isRealLookupFailure\(flagErr\)\) throw/)
  })
})

describe('B4 reminder cooldown fails closed', () => {
  it('allows when nothing recent', async () => {
    expect(await checkReminderCooldown(fake({ audit_log: { data: null, error: null } }), 'change_order', 'x')).toEqual({ allowed: true })
  })
  it('blocks on a recent reminder', async () => {
    const svc = fake({ audit_log: [{ data: { id: '1', created_at: new Date().toISOString() }, error: null }, { data: null, error: null }] })
    const r = await checkReminderCooldown(svc, 'change_order', 'x')
    expect(r.allowed).toBe(false)
  })
  it('throws on a failed read instead of allowing a duplicate email', async () => {
    await expect(checkReminderCooldown(fake({ audit_log: { data: null, error: { message: 'down' } } }), 'change_order', 'x')).rejects.toThrow(/cooldown lookup failed/)
  })
})

describe('B5 computeCoTotals rejects non-numeric quantities', () => {
  const one = (quantity: unknown, rate: unknown = 5) => computeCoTotals([{ description: 'a', quantity, rate }], 0, false)
  const noRate = () => computeCoTotals([{ description: 'a', quantity: 1 }], 0, false)
  it.each([[null], [undefined], [true], [false], [[]], [{}], ['']])('rejects quantity %j', (q) => {
    expect(one(q).ok).toBe(false)
  })
  it.each([[2, 10], ['2', 10], [' 3 ', 15], [0, 0], [1.5, 7.5]])('accepts quantity %j', (q, total) => {
    const r = one(q)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totals.total).toBe(total)
  })
  it('rejects a boolean / array rate but still allows a blank or null (unpriced) rate', () => {
    expect(one(1, true).ok).toBe(false)
    expect(one(1, []).ok).toBe(false)
    expect(one(1, null).ok).toBe(true)
    expect(one(1, '').ok).toBe(true)
  })
  it('still rejects a missing rate', () => expect(noRate().ok).toBe(false))
})

describe('B6 executed CO PDF matches the live render inputs', () => {
  const src = read('lib/documents/finalize-co.ts')
  it('passes the accepted status and the re-sanitized note', () => {
    expect(src).toMatch(/status:\s+'accepted'/)
    expect(src).toMatch(/note:\s+sanitizeRichTextOrNull\(co\.note\)/)
  })
})
