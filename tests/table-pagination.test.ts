import { describe, it, expect } from 'vitest'
import React from 'react'
import {
  SowTable, estimateSowTableHeight, TABLE_KEEP_TOGETHER_MAX_HEIGHT, TABLE_UNSPLITTABLE_SAFE_HEIGHT, TABLE_MIN_ROWS_AT_BREAK,
} from '@/lib/pdf/sow-table'
import { SOW_TABLE_SCHEMAS } from '@/lib/sow/table-schema'
import { buildSowContentPrompt, type SowContentInput } from '@/lib/ai/sow-content'

// Walk a React element tree (function components are expanded) and collect every element.
function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out }
  if (typeof node.type === 'function') return walk(node.type(node.props), out)
  out.push(node)
  walk(node.props?.children, out)
  return out
}

const deliverable = (i: number, targetDate = 'July 21, 2026') => ({
  deliverable: `Deliverable number ${i}`, acceptanceCriteria: 'Pages display correctly on current browsers', owner: 'Provider', targetDate,
})
const rowsOf = (n: number, targetDate?: string) => Array.from({ length: n }, (_, i) => deliverable(i, targetDate))

describe('estimateSowTableHeight', () => {
  it('grows with the number of rows and with how much text wraps', () => {
    expect(estimateSowTableHeight('deliverables', rowsOf(8))).toBeGreaterThan(estimateSowTableHeight('deliverables', rowsOf(4)))
    expect(estimateSowTableHeight('deliverables', rowsOf(4, 'Build and Content Integration – July 21, 2026')))
      .toBeGreaterThan(estimateSowTableHeight('deliverables', rowsOf(4, 'July 21, 2026')))
  })
  it('an empty table is a small placeholder', () => {
    expect(estimateSowTableHeight('deliverables', [])).toBeLessThan(100)
    expect(estimateSowTableHeight('deliverables', undefined)).toBeLessThan(100)
  })
  it('a typical 4-row deliverables table is comfortably kept whole, a 20-row one is allowed to flow', () => {
    expect(estimateSowTableHeight('deliverables', rowsOf(4))).toBeLessThanOrEqual(TABLE_KEEP_TOGETHER_MAX_HEIGHT)
    expect(estimateSowTableHeight('deliverables', rowsOf(20))).toBeGreaterThan(TABLE_KEEP_TOGETHER_MAX_HEIGHT)
  })
  it('the keep-whole ceiling leaves a safety margin below what one page can draw', () => {
    expect(TABLE_KEEP_TOGETHER_MAX_HEIGHT).toBeLessThan(TABLE_UNSPLITTABLE_SAFE_HEIGHT)
    expect(TABLE_UNSPLITTABLE_SAFE_HEIGHT).toBeLessThan(700) // A4 content area is ~745pt less the continuation masthead
  })
  it('long target dates no longer make a row taller than its description does (a date fits one line in the widened column)', () => {
    const one = estimateSowTableHeight('deliverables', [deliverable(1, 'September 30, 2026')])
    const none = estimateSowTableHeight('deliverables', [deliverable(1, '')])
    expect(one).toBe(none)
  })
  it('deliverables column widths still sum to the schema total the editor expects', () => {
    expect(SOW_TABLE_SCHEMAS.deliverables.columns.reduce((s, c) => s + (c.width ?? 1), 0)).toBeCloseTo(10, 5)
  })
})

describe('a table that has to split never leaves a lone row', () => {
  const lead = React.createElement('span', null, 'HEAD')
  const groups = (n: number) => {
    const els = walk(SowTable({ sectionId: 'deliverables', rows: rowsOf(n), language: 'en', lead }))
    const unsplittable = els.filter(e => e.props.wrap === false && e.type !== 'span')
    // a row is a View whose children are the four cells; a group is an unsplittable View that contains rows
    const sizeOf = (g: any) => walk(g.props.children).filter(e => e.props.wrap === false).length
    return { els, groups: unsplittable.filter(g => walk(g.props.children).some(e => e.props.wrap === false)), sizeOf, unsplittable }
  }
  it('keeps every row, whatever the length', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 9, 30]) {
      const { unsplittable, groups: g } = groups(n)
      expect(unsplittable.length - g.length).toBe(n) // rows = unsplittable views that are not groups
    }
  })
  it('puts TABLE_MIN_ROWS_AT_BREAK rows with the heading and TABLE_MIN_ROWS_AT_BREAK in the closing group for 4+ rows', () => {
    for (const n of [4, 5, 6, 12, 30]) {
      const { groups: g, sizeOf } = groups(n)
      expect(g).toHaveLength(2)
      expect(g.map(sizeOf)).toEqual([TABLE_MIN_ROWS_AT_BREAK, TABLE_MIN_ROWS_AT_BREAK])
    }
  })
  it('a table of three rows or fewer is a single group (nothing to split)', () => {
    for (const n of [1, 2, 3]) expect(groups(n).groups).toHaveLength(1)
  })
})

describe('SOW drafting prompt keeps the Target Date cell short', () => {
  const base = {
    agencyName: 'A', clientName: 'B', projectName: 'P', projectType: 'Web', contractValue: 3000, currency: 'USD',
    paymentLabel: '50/50', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'Texas',
  } as SowContentInput
  it('asks for the date alone, falling back to the phase name only when there are no dates', () => {
    const p = buildSowContentPrompt(base)
    expect(p).toContain('written as the date alone')
    expect(p).toContain('do NOT repeat the phase name')
    expect(p).toContain('Only when the brief gives no dates')
  })
})
