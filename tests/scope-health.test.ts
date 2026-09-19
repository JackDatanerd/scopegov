import { describe, it, expect } from 'vitest'
import { computeScopeHealth } from '@/lib/reports/scope-health'

// Minimal fake of the supabase-js query builder: every filter method returns
// the builder; `.range()` resolves to the table's rows (paged) with a count.
function fakeService(tables: Record<string, any[] | { error: string }>) {
  return {
    from(name: string) {
      const t = tables[name]
      const b: any = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'neq', 'gte', 'lt']) b[m] = () => b
      b.range = (from: number, to: number) => {
        if (t && !Array.isArray(t)) return Promise.resolve({ data: null, error: { message: t.error } })
        const rows = (t as any[]) || []
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: rows.length })
      }
      return b
    },
  }
}

const proj = (id: string, over: any = {}) => ({
  id, name: id, status: 'Active', stall_reason: null, contract_value: 10000, currency: 'USD',
  updated_at: '2026-09-01T00:00:00Z', clients: { name: 'C' }, ...over,
})

describe('computeScopeHealth', () => {
  it('counts flags across ALL currencies but sums money in the dominant one', async () => {
    const svc = fakeService({
      projects: [proj('a'), proj('b'), proj('e', { currency: 'EUR', contract_value: 4000 })],
      guardian_flags: [
        { id: 'f1', project_id: 'a', severity: 'high', status: 'open' },
        { id: 'f2', project_id: 'e', severity: 'high', status: 'open' },
      ],
      exceptions_log: [], amendments: [], change_orders: [],
    })
    const h = await computeScopeHealth(svc, 'w')
    expect(h.currency).toBe('USD')
    expect(h.openFlagsCount).toBe(2)            // the EUR flag is not dropped
    expect(h.contractValueAtRisk).toBe(500)     // 10000 * 5% * 1.0, USD only
    expect(h.byCurrency.find(c => c.currency === 'EUR')?.contractValueAtRisk).toBe(200)
  })

  it('ignores finished projects and past exceptions on them', async () => {
    const svc = fakeService({
      projects: [proj('a'), proj('done', { status: 'Complete' })],
      guardian_flags: [{ id: 'f', project_id: 'done', severity: 'high', status: 'open' }],
      exceptions_log: [{ id: 'x', project_id: 'done', estimated_value: 5000, guardian_flags: null }],
      amendments: [], change_orders: [],
    })
    const h = await computeScopeHealth(svc, 'w')
    expect(h.openFlagsCount).toBe(0)
    expect(h.contractValueAtRisk).toBe(0)        // sunk exception is not live exposure
    expect(h.exceptionsCount).toBe(1)            // still counted all-time
    expect(h.exceptionsValueTotal).toBe(5000)
  })

  it('caps per-project flag risk at the effective contract value', async () => {
    const flags = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, project_id: 'a', severity: 'high', status: 'open' }))
    const svc = fakeService({
      projects: [proj('a', { contract_value: 1000 })],
      guardian_flags: flags, exceptions_log: [], change_orders: [],
      amendments: [{ id: 'm', project_id: 'a', financial_impact: 500 }],
    })
    const h = await computeScopeHealth(svc, 'w')
    expect(h.contractValueAtRisk).toBe(1500)     // 40*5% would be 200% — capped at effective 1500
  })

  it('counts borderline flags separately and leaves them out of at-risk', async () => {
    const svc = fakeService({
      projects: [proj('a')],
      guardian_flags: [{ id: 'f', project_id: 'a', severity: 'high', status: 'borderline_review' }],
      exceptions_log: [], amendments: [], change_orders: [],
    })
    const h = await computeScopeHealth(svc, 'w')
    expect(h.borderlineFlagsCount).toBe(1)
    expect(h.openFlagsCount).toBe(0)
    expect(h.contractValueAtRisk).toBe(0)
  })

  it('throws on a failed read instead of reporting an all-clear', async () => {
    const svc = fakeService({ projects: { error: 'boom' }, guardian_flags: [], exceptions_log: [], amendments: [], change_orders: [] })
    await expect(computeScopeHealth(svc, 'w')).rejects.toThrow(/boom/)
  })

  it('counts stalled SOW projects', async () => {
    const svc = fakeService({
      projects: [proj('a', { status: 'Stalled', stall_reason: 'sow_unsigned' }), proj('b', { status: 'Stalled', stall_reason: 'manual' })],
      guardian_flags: [], exceptions_log: [], amendments: [], change_orders: [],
    })
    const h = await computeScopeHealth(svc, 'w')
    expect(h.stalledSowCount).toBe(1)
    expect(h.activeProjectCount).toBe(2)         // Stalled is in progress
  })
})
