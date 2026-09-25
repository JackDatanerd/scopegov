import { describe, it, expect } from 'vitest'
import { computeScopeHealth } from '@/lib/reports/scope-health'
import { getPortfolioData } from '@/lib/reports/portfolio-data'

// Minimal fake of the supabase-js builder: every filter returns the builder; `.range()` pages the table's rows;
// `.limit()` (used by the retainer-months lookup) resolves the rows directly.
function fakeService(tables: Record<string, any[]>) {
  return {
    from(name: string) {
      const rows = tables[name] || []
      const b: any = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'neq', 'gte', 'lt']) b[m] = () => b
      b.range = (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: rows.length })
      b.limit = () => Promise.resolve({ data: rows, error: null })
      return b
    },
  }
}

const proj = (id: string, over: any = {}) => ({
  id, name: id, type: 'fixed', status: 'Active', stall_reason: null, stalled_at: null, contract_value: 10000,
  retainer_duration_months: null, currency: 'USD', updated_at: '2026-09-01T00:00:00Z', clients: { name: `Client of ${id}` }, ...over,
})
const empty = { guardian_flags: [], exceptions_log: [], amendments: [], change_orders: [], sow_documents: [], payment_milestones: [], scope_health_snapshots: [] }

describe('scope health — effective value is the shared definition', () => {
  it('a fixed-term retainer is exposed on monthly × term, not on one month', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('ret', { type: 'retainer', contract_value: 2000, retainer_duration_months: 12 })],
      guardian_flags: [{ id: 'f', project_id: 'ret', severity: 'high', status: 'open', description: 'd', sow_reference: 's', created_at: '2026-09-02T00:00:00Z' }],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    expect(h.contractValueAtRisk).toBe(1200)            // 24,000 × 5% × 1.0 — it used to be 2,000 × 5% = 100
    expect(h.projects[0].effectiveValue).toBe(24000)
  })

  it('an open-ended retainer counts the months contracted so far', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('open', { type: 'retainer', contract_value: 1000, retainer_duration_months: null })],
      payment_milestones: [{ id: '1', project_id: 'open' }, { id: '2', project_id: 'open' }, { id: '3', project_id: 'open' }, { id: '4', project_id: 'open' }],
      guardian_flags: [{ id: 'f', project_id: 'open', severity: 'high', status: 'open', description: 'd', sow_reference: 's', created_at: '2026-09-02T00:00:00Z' }],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    expect(h.projects[0].effectiveValue).toBe(4000)
    expect(h.contractValueAtRisk).toBe(200)
  })

  it('a legacy retainer-renewal amendment is not counted on top of the rate it replaced', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('ret', { type: 'retainer', contract_value: 3000, retainer_duration_months: 6 })],
      amendments: [
        { id: 'a1', project_id: 'ret', financial_impact: 18000, change_orders: { is_retainer_renewal: true } },
        { id: 'a2', project_id: 'ret', financial_impact: 500, change_orders: { is_retainer_renewal: false } },
      ],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    expect(h.projects[0].effectiveValue).toBe(18500)    // 3,000×6 + 500, not + 18,000 more
  })
})

describe('scope health — projects by risk', () => {
  const flag = (id: string, project_id: string, severity: string, status = 'open') =>
    ({ id, project_id, severity, status, description: id, sow_reference: 's', created_at: '2026-09-02T00:00:00Z' })

  it('per-project rows add up to the headline, biggest exposure first; quiet projects are omitted', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('big', { contract_value: 100000 }), proj('small', { contract_value: 1000 }), proj('quiet'), proj('done', { status: 'Complete' })],
      guardian_flags: [flag('f1', 'big', 'high'), flag('f2', 'big', 'low'), flag('f3', 'small', 'high'), flag('f4', 'big', 'high', 'borderline_review'), flag('f5', 'done', 'high')],
      exceptions_log: [{ id: 'x', project_id: 'small', estimated_value: 400, guardian_flags: { severity: 'medium' }, deliverable: 'd', granted_what: 'g', reason: 'r', created_at: '2026-09-03T00:00:00Z' }],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    expect(h.projectRisk.map(r => r.projectId)).toEqual(['big', 'small'])
    const big = h.projectRisk[0]
    expect(big).toMatchObject({ openFlags: 2, highFlags: 1, borderlineFlags: 1 })
    expect(big.flagRisk).toBe(100000 * 0.05 * 1.0 + 100000 * 0.05 * 0.2) // 5,000 + 1,000
    const small = h.projectRisk[1]
    expect(small.exceptionsCount).toBe(1)
    expect(small.exceptionsRisk).toBe(200)               // 400 × 0.5 (medium)
    expect(h.projectRisk.reduce((s, r) => s + r.atRisk, 0)).toBeCloseTo(h.contractValueAtRisk, 2)
  })

  it('the cron path (no detail) returns no per-project rows and does not need the detail tables', async () => {
    const h = await computeScopeHealth(fakeService({ ...empty, projects: [proj('a')] }), 'w')
    expect(h.projectRisk).toEqual([])
    expect(h.stuckDocs).toEqual([])
    expect(h.exceptions).toEqual([])
  })
})

describe('scope health — documents needing action', () => {
  it('lists stalled AND declined/expired/countered COs and a declined CURRENT SOW; skips old versions and finished projects', async () => {
    const svc = fakeService({
      ...empty,
      projects: [
        proj('p1'), proj('p2', { status: 'Stalled', stall_reason: 'sow_unsigned', stalled_at: '2026-08-01T00:00:00Z' }),
        proj('p3'), proj('done', { status: 'Complete' }),
      ],
      change_orders: [
        { id: 'c1', project_id: 'p1', status: 'stalled', title: 'Extra pages', total: 500, updated_at: '2026-09-10T00:00:00Z', stalled_at: '2026-09-05T00:00:00Z' },
        { id: 'c2', project_id: 'p1', status: 'declined', title: 'Rush fee', total: 900, updated_at: '2026-09-08T00:00:00Z', stalled_at: null },
        { id: 'c3', project_id: 'done', status: 'declined', title: 'ignored', total: 1, updated_at: '2026-09-08T00:00:00Z', stalled_at: null },
      ],
      sow_documents: [
        { id: 's1', project_id: 'p3', version: 1, status: 'declined', updated_at: '2026-07-01T00:00:00Z', declined_at: '2026-07-01T00:00:00Z', expires_at: null },
        { id: 's2', project_id: 'p3', version: 2, status: 'changes_requested', updated_at: '2026-09-09T00:00:00Z', declined_at: null, expires_at: null },
      ],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    const summary = h.stuckDocs.map(d => `${d.kind}:${d.reason}:${d.projectId}`).sort()
    expect(summary).toEqual([
      'CO:Declined:p1', 'CO:Stalled:p1', 'SOW:Changes requested:p3', 'SOW:SOW unsigned:p2',
    ])
    // Headline counts are unchanged: only STALLED items feed the Stalled tile.
    expect(h.stalledCoCount).toBe(1)
    expect(h.stalledSowCount).toBe(1)
    // "since" is when it stalled, not the last unrelated edit.
    expect(h.stuckDocs.find(d => d.docId === 'c1')!.since).toBe('2026-09-05T00:00:00Z')
    expect(h.stuckDocs.find(d => d.projectId === 'p2')!.since).toBe('2026-08-01T00:00:00Z')
    // and it is oldest-first
    expect(h.stuckDocs.map(d => d.since)).toEqual([...h.stuckDocs.map(d => d.since)].sort())
  })

  it('falls back to updated_at when a row has no stalled_at yet (pre-migration data)', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('p2', { status: 'Stalled', stall_reason: 'sow_unsigned', stalled_at: null, updated_at: '2026-08-15T00:00:00Z' })],
    })
    const h = await computeScopeHealth(svc, 'w', { withDetail: true })
    expect(h.stuckDocs[0].since).toBe('2026-08-15T00:00:00Z')
  })
})

describe('portfolio data', () => {
  const flag = (i: number, sev: string, project = 'a') => ({
    id: `f-${sev}-${String(i).padStart(4, '0')}`, project_id: project, severity: sev, status: 'open',
    description: `flag ${i}`, sow_reference: 's', created_at: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
  })

  it('the flag list is capped PER SEVERITY, so filtering to "low" is never starved by newer high flags', async () => {
    const flags = [
      ...Array.from({ length: 150 }, (_, i) => flag(i, 'high')),
      ...Array.from({ length: 7 }, (_, i) => flag(i, 'low')),
    ]
    const svc = fakeService({ ...empty, projects: [proj('a')], guardian_flags: flags })
    const d = await getPortfolioData(svc, 'w', '90d', true, true)
    expect(d.openFlagsTotal).toBe(157)
    expect(d.openFlags.filter(f => f.severity === 'high')).toHaveLength(100)
    expect(d.openFlags.filter(f => f.severity === 'low')).toHaveLength(7)  // used to be 0 — capped away
    expect(d.openFlags[0].severity).toBe('high')                           // still severity-first
    expect(d.current.openFlagsBySeverity).toEqual({ high: 150, medium: 0, low: 7 })
  })

  it('the export can ask for every flag', async () => {
    const svc = fakeService({ ...empty, projects: [proj('a')], guardian_flags: Array.from({ length: 150 }, (_, i) => flag(i, 'high')) })
    const d = await getPortfolioData(svc, 'w', '90d', true, true, { flagsPerSeverity: 5000 })
    expect(d.openFlags).toHaveLength(150)
  })

  it('withholds money and client names without the permissions, in every new section', async () => {
    const svc = fakeService({
      ...empty,
      projects: [proj('a')],
      guardian_flags: [flag(1, 'high')],
      exceptions_log: [{ id: 'x', project_id: 'a', estimated_value: 900, guardian_flags: null, deliverable: 'd', granted_what: 'g', reason: 'r', created_at: '2026-09-03T00:00:00Z' }],
      change_orders: [{ id: 'c', project_id: 'a', status: 'declined', title: 'T', total: 700, updated_at: '2026-09-04T00:00:00Z', stalled_at: null }],
    })
    const d = await getPortfolioData(svc, 'w', '90d', false, false)
    expect(d.projectRisk[0]).toMatchObject({ clientName: null, effectiveValue: null, flagRisk: null, exceptionsRisk: null, atRisk: null })
    expect(d.stuckDocs[0]).toMatchObject({ clientName: null, total: null })
    expect(d.exceptions[0]).toMatchObject({ clientName: null, estimatedValue: null })
    expect(JSON.stringify(d)).not.toContain('Client of a')
  })

  it('exposes the risk constants so the on-page explanation cannot drift from the maths', async () => {
    const d = await getPortfolioData(fakeService({ ...empty, projects: [proj('a')] }), 'w', '90d', true, true)
    expect(d.riskModel).toEqual({ openFlagRate: 0.05, severityMultipliers: { high: 1, medium: 0.5, low: 0.2 } })
  })
})
