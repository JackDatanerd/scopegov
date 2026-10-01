import { describe, it, expect } from 'vitest'
import { chartAxis, formatAxisTick } from '@/lib/reports/portfolio-chart-axis'

const labels = (values: number[], mode: 'risk' | 'flags', cur = 'USD') => {
  const a = chartAxis(values, mode)
  return a.ticks.map(t => formatAxisTick(t, mode, cur, a))
}

describe('portfolio trend chart axis', () => {
  it('flag ticks are always whole numbers that sit exactly where their gridline is', () => {
    for (const peak of [0, 1, 2, 3, 5, 7, 11, 100, 101]) {
      const a = chartAxis([0, peak], 'flags')
      for (const t of a.ticks) expect(Number.isInteger(t)).toBe(true)
      expect(a.max).toBeGreaterThanOrEqual(peak)
      expect(a.ticks[1]).toBe(a.max / 2)
    }
    expect(labels([2, 3], 'flags')).toEqual(['4', '2', '0'])
    expect(labels([1, 1], 'flags')).toEqual(['2', '1', '0'])
  })

  it('a zero-risk series labels only the zero line', () => {
    expect(labels([0, 0, 0], 'risk')).toEqual(['', '', 'USD 0'])
  })

  it('a risk axis uses one label style top to bottom', () => {
    expect(labels([0, 1500], 'risk')).toEqual(['USD 1.5k', 'USD 750', 'USD 0'])
    expect(labels([0, 800], 'risk')).toEqual(['USD 800', 'USD 400', 'USD 0'])
    expect(labels([0, 4000], 'risk', 'KES')).toEqual(['KES 4k', 'KES 2k', 'KES 0'])
  })
})
