// lib/reports/portfolio-chart-axis.ts
//
// Y-axis scale + tick labels for the Portfolio trend chart, as pure functions so they can be tested.
//
// FIX (Portfolio independent pass 8): TrendChart used to draw its three gridlines at [max, max/2, 0] but label them
// with a formatter that did not match where the lines sit:
//  - flags mode rounded the middle tick, so with a max of 3 the gridline sat at 1.5 and was labelled "2" (max 5 -> 2.5
//    labelled "3"; max 1 -> labels "1, 1, 0");
//  - risk mode floored the scale at 1, so a flat zero-risk line showed its top gridline as "$1";
//  - the compact currency formatter only abbreviates from 1,000, so one axis could read "USD 1.5k / $750 / $0".
// The scale now guarantees whole-number ticks for counts, labels nothing but the zero line when there is no risk to
// show, and uses one label style per axis.

import { formatCurrency } from '@/lib/utils/format'

export type ChartMode = 'risk' | 'flags'

export interface ChartAxis {
  min: number
  max: number
  /** Gridline values, top / middle / bottom. */
  ticks: [number, number, number]
  /** Risk mode with every point at zero: there is no meaningful scale to label. */
  blank: boolean
}

export function chartAxis(values: number[], mode: ChartMode): ChartAxis {
  const peak = values.length ? Math.max(...values) : 0
  if (mode === 'flags') {
    // Even top so the middle gridline is a whole number too (counts have no half-flags).
    const m = Math.max(Math.ceil(peak), 1)
    const top = m + (m % 2)
    return { min: 0, max: top, ticks: [top, top / 2, 0], blank: false }
  }
  const blank = !(peak > 0)
  const top = blank ? 1 : peak
  return { min: 0, max: top, ticks: [top, top / 2, 0], blank }
}

export function formatAxisTick(v: number, mode: ChartMode, currency: string, axis: ChartAxis): string {
  if (mode === 'flags') return String(Math.round(v))
  if (axis.blank) return v === 0 ? `${currency} 0` : ''
  // One style for the whole axis: currency-code prefix, abbreviated only when the axis itself reaches thousands.
  if (axis.max >= 1000) return v === 0 ? `${currency} 0` : v >= 1000 ? formatCurrency(v, currency, true) : `${currency} ${Math.round(v)}`
  return `${currency} ${Math.round(v)}`
}
