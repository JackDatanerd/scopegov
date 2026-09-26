import { describe, it, expect } from 'vitest'
import {
  baseContractValue, amendmentImpact, effectiveContractValue, monthlyRetainerRate,
  isOpenEndedRetainer, loadRetainerMonthsBilled,
} from '@/lib/utils/contract-value'
import { wouldExceedLimit, isOverLimit, projectLimitMessage, projectLimitFor } from '@/lib/utils/project-limit'

describe('contract value — one definition', () => {
  it('a fixed project is worth its stored value plus accepted change orders', () => {
    const p = { contract_value: 10000, type: 'fixed' }
    expect(effectiveContractValue(p, [{ financial_impact: 2500 }, { financial_impact: '500' }])).toBe(13000)
  })

  it('a fixed-term retainer is monthly rate × months, not one month', () => {
    const p = { contract_value: 2000, type: 'retainer', retainer_duration_months: 12 }
    expect(baseContractValue(p)).toBe(24000)
    expect(monthlyRetainerRate(p)).toBe(2000)
  })

  it('an open-ended retainer is worth the months contracted so far (min 1)', () => {
    const p = { contract_value: 2000, type: 'retainer', retainer_duration_months: null }
    expect(isOpenEndedRetainer(p)).toBe(true)
    expect(baseContractValue(p, 5)).toBe(10000)
    expect(baseContractValue(p, 0)).toBe(2000)
    expect(baseContractValue(p)).toBe(2000)
  })

  it('retainer-renewal amendments are NOT added on top of the rate they replaced — for retainers only', () => {
    const amendments = [
      { financial_impact: 6000, change_orders: { is_retainer_renewal: true } },
      { financial_impact: 1000, change_orders: { is_retainer_renewal: false } },
      { financial_impact: 500, change_orders: [{ is_retainer_renewal: true }] }, // array-shaped embed
    ]
    expect(amendmentImpact(amendments, 'retainer')).toBe(1000)
    // A non-retainer never has renewal COs, so nothing is excluded there.
    expect(amendmentImpact(amendments, 'fixed')).toBe(7500)
  })

  it('never goes negative', () => {
    expect(effectiveContractValue({ contract_value: 1000, type: 'fixed' }, [{ financial_impact: -5000 }])).toBe(0)
  })

  it('monthly rate is null for non-retainers', () => {
    expect(monthlyRetainerRate({ contract_value: 100, type: 'fixed' })).toBeNull()
  })

  it('only queries milestones for OPEN-ENDED retainers and counts per project', async () => {
    const calls: any[] = []
    const service = {
      from(table: string) {
        const b: any = { _table: table }
        b.select = () => b
        b.in = (_c: string, ids: string[]) => { calls.push(ids); return b }
        b.eq = () => b
        // FIX (Projects & Dashboard / Portfolio independent pass, round 2): loadRetainerMonthsBilled
        // now pages via .range() instead of a single .limit(5000) (see that function's own comment —
        // the old single limit() silently truncated with no signal). Mock terminates on .range() now.
        b.range = () => Promise.resolve({ data: [{ id: '1', project_id: 'open' }, { id: '2', project_id: 'open' }, { id: '3', project_id: 'open' }], error: null })
        return b
      },
    }
    const months = await loadRetainerMonthsBilled(service, [
      { id: 'open', contract_value: 1, type: 'retainer', retainer_duration_months: null },
      { id: 'fixedterm', contract_value: 1, type: 'retainer', retainer_duration_months: 6 },
      { id: 'proj', contract_value: 1, type: 'fixed' },
    ])
    expect(calls).toEqual([['open']])
    expect(months.get('open')).toBe(3)
  })

  it('pages past 1,000 rows instead of silently truncating (regression for the old .limit(5000))', async () => {
    // Two pages: 1000 rows, then a final 1 row — proves the loop keeps paging until a
    // short page tells it to stop, rather than trusting a single capped read.
    let call = 0
    const service = {
      from: () => {
        const b: any = {}
        b.select = () => b; b.in = () => b; b.eq = () => b
        b.range = () => {
          call++
          if (call === 1) return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), project_id: 'open' })), error: null })
          return Promise.resolve({ data: [{ id: '1000', project_id: 'open' }], error: null })
        }
        return b
      },
    }
    const months = await loadRetainerMonthsBilled(service, [{ id: 'open', contract_value: 1, type: 'retainer', retainer_duration_months: null }])
    expect(call).toBe(2)
    expect(months.get('open')).toBe(1001)
  })

  it('a failed lookup degrades to "no months known" instead of throwing', async () => {
    const service = { from: () => { const b: any = {}; b.select = () => b; b.in = () => b; b.eq = () => b; b.range = () => Promise.resolve({ data: null, error: { message: 'boom' } }); return b } }
    const months = await loadRetainerMonthsBilled(service, [{ id: 'x', contract_value: 1, type: 'retainer', retainer_duration_months: null }])
    expect(months.size).toBe(0)
  })
})

// Fake supabase: head-count query on projects.
function countingService(count: number) {
  return {
    from() {
      const b: any = {}
      b.select = () => b; b.eq = () => b; b.is = () => b
      b.in = () => Promise.resolve({ count, error: null })
      return b
    },
  }
}

describe('plan project limit — shared by create AND reopen', () => {
  it('solo is capped at 2; trial/pro/agency are unlimited', () => {
    expect(projectLimitFor('solo')).toBe(2)
    expect(projectLimitFor('pro')).toBeNull()
    expect(projectLimitFor('trial')).toBeNull()
  })

  it('blocks when the workspace is already at its allowance (reopen would be the 3rd live project)', async () => {
    expect(await wouldExceedLimit(countingService(2), 'w', 'solo')).toBe(true)
    expect(await wouldExceedLimit(countingService(1), 'w', 'solo')).toBe(false)
    expect(await wouldExceedLimit(countingService(99), 'w', 'pro')).toBe(false)
  })

  it('post-write race check trips only when the count went PAST the allowance', async () => {
    expect(await isOverLimit(countingService(3), 'w', 'solo')).toBe(true)
    expect(await isOverLimit(countingService(2), 'w', 'solo')).toBe(false)
  })

  it('the error names the actions that actually work (a Draft can be deleted, not completed)', () => {
    const create = projectLimitMessage('solo', 'create')
    expect(create).toMatch(/limited to 2 active projects/)
    expect(create).toMatch(/delete a draft/i)
    expect(create).not.toMatch(/archive one/i)
    expect(projectLimitMessage('solo', 'reopen')).toMatch(/Reopening this project would put you over/)
  })

  it('a failed count read throws — it must never look like "under the limit"', async () => {
    const svc = { from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.is = () => b; b.in = () => Promise.resolve({ count: null, error: { message: 'db down' } }); return b } }
    await expect(wouldExceedLimit(svc, 'w', 'solo')).rejects.toThrow(/plan limit check failed/)
  })
})
