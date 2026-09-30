import { describe, it, expect } from 'vitest'
import { groupRiskByClient, type ClientRiskInputRow } from '@/lib/reports/portfolio-client-groups'

const row = (over: Partial<ClientRiskInputRow> = {}): ClientRiskInputRow => ({
  clientId: 'c1', clientName: 'Acme', currency: 'USD', openFlags: 1, highFlags: 0, stuckDocs: 0, atRisk: 100, ...over,
})

describe('portfolio "By client" roll-up', () => {
  it('sums the projects of ONE client', () => {
    const g = groupRiskByClient([row({ atRisk: 100, openFlags: 2 }), row({ atRisk: 50, openFlags: 1, highFlags: 1 })], 'USD')
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ client: 'Acme', projects: 2, openFlags: 3, highFlags: 1, risk: [['USD', 150]] })
  })

  it('does not merge two different clients that share a name (names are not unique — emails are)', () => {
    const g = groupRiskByClient([
      row({ clientId: 'c-a', atRisk: 100 }),
      row({ clientId: 'c-b', atRisk: 900 }),
    ], 'USD')
    expect(g).toHaveLength(2)
    expect(g.map(x => x.client).sort()).toEqual(['Acme (#1)', 'Acme (#2)'])
    // Suffixes are stable: tied to the id order, not to the exposure ranking.
    expect(g.find(x => x.key === 'id:c-a')!.client).toBe('Acme (#1)')
    expect(g.find(x => x.key === 'id:c-b')!.client).toBe('Acme (#2)')
    expect(g[0].key).toBe('id:c-b') // bigger exposure first
  })

  it('leaves a unique name unsuffixed', () => {
    const g = groupRiskByClient([row({ clientId: 'c-a' }), row({ clientId: 'c-b', clientName: 'Globex' })], 'USD')
    expect(g.map(x => x.client).sort()).toEqual(['Acme', 'Globex'])
  })

  it('never ranks across currencies: headline-currency exposure first, each currency shown separately', () => {
    const g = groupRiskByClient([
      row({ clientId: 'kes', clientName: 'Kenya Co', currency: 'KES', atRisk: 500000 }),
      row({ clientId: 'usd', clientName: 'US Co', currency: 'USD', atRisk: 20000 }),
    ], 'USD')
    expect(g.map(x => x.client)).toEqual(['US Co', 'Kenya Co']) // the old cross-currency sum put KES first
    const mixed = groupRiskByClient([
      row({ currency: 'KES', atRisk: 500000 }), row({ currency: 'USD', atRisk: 20000 }),
    ], 'USD')
    expect(mixed[0].risk).toEqual([['USD', 20000], ['KES', 500000]]) // headline currency listed first, never added together
  })

  it('without VIEW_FINANCIALS there is no money, and groups order by open flags', () => {
    const g = groupRiskByClient([
      row({ clientId: 'a', clientName: 'Low', atRisk: null, openFlags: 1 }),
      row({ clientId: 'b', clientName: 'High', atRisk: null, openFlags: 5 }),
    ], 'USD')
    expect(g.map(x => x.client)).toEqual(['High', 'Low'])
    expect(g.every(x => x.risk.length === 0)).toBe(true)
  })

  it('projects with no client share one "No client" group; an id with an empty name is "Unnamed client"', () => {
    const g = groupRiskByClient([
      row({ clientId: null, clientName: null }), row({ clientId: null, clientName: null }),
      row({ clientId: 'x', clientName: null }),
    ], 'USD')
    expect(g.find(x => x.client === 'No client')!.projects).toBe(2)
    expect(g.find(x => x.client === 'Unnamed client')!.projects).toBe(1)
  })

  it('falls back to the name when an older payload carries no clientId', () => {
    const g = groupRiskByClient([
      { clientName: 'Acme', currency: 'USD', openFlags: 1, highFlags: 0, stuckDocs: 0, atRisk: 10 },
      { clientName: 'Acme', currency: 'USD', openFlags: 1, highFlags: 0, stuckDocs: 0, atRisk: 10 },
    ], 'USD')
    expect(g).toHaveLength(1)
    expect(g[0].projects).toBe(2)
  })
})
