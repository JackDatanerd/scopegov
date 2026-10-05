import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { parseTableAmount as p } from '@/lib/sow/table-schema'
import { amountsMentioned } from '@/lib/sow/validate-send'
import { parseTableSections } from '@/lib/ai/sow-content'
import { sanitizeTableRows, hydrateSections } from '@/lib/sow/sections'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { SowTable, COL_GUTTER } from '@/lib/pdf/sow-table'
import { renderSowPdf } from '@/lib/pdf/renderer'

// SOW lifecycle, independent pass 12.
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

// Walk a React element tree (function components are expanded) and collect every element.
function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out }
  if (typeof node.type === 'function') return walk(node.type(node.props), out)
  out.push(node)
  walk(node.props?.children, out)
  return out
}
const flat = (style: any): Record<string, any> => Object.assign({}, ...[style].flat(5).filter(Boolean))

describe('B1 — PDF table columns have a gutter', () => {
  const rows = [{ milestone: 'Kickoff', amount: '5000', trigger: 'On signing' }]
  const els = walk(SowTable({ sectionId: 'payment_schedule', rows, language: 'en' }))
  it('every column but the last carries the right gutter, the last carries none', () => {
    const headerCells = els.filter(e => flat(e.props.style).fontSize === 7.5)
    expect(headerCells).toHaveLength(3)
    expect(headerCells.map(c => flat(c.props.style).paddingRight)).toEqual([COL_GUTTER, COL_GUTTER, 0])
    const bodyCells = els.filter(e => flat(e.props.style).fontSize === 9)
    expect(bodyCells.map(c => flat(c.props.style).paddingRight)).toEqual([COL_GUTTER, COL_GUTTER, 0])
  })
})

describe('B2 — a table row never splits across pages', () => {
  it('every data row is wrap={false}', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ deliverable: `D${i}`, acceptanceCriteria: 'ok', owner: 'Provider', targetDate: '' }))
    const els = walk(SowTable({ sectionId: 'deliverables', rows, language: 'en' }))
    const dataRows = els.filter(e => e.props.wrap === false)
    expect(dataRows).toHaveLength(5)
  })
  it('a long table renders as the heading group + remaining rows without losing a row', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ deliverable: `D${i}`, acceptanceCriteria: 'ok', owner: 'Provider', targetDate: '' }))
    const els = walk(SowTable({ sectionId: 'deliverables', rows, language: 'en', lead: React.createElement('span', null, 'HEAD') }))
    expect(els.filter(e => e.props.wrap === false && e.type !== 'span')).toHaveLength(31) // 30 rows + the lead group
    expect(els.some(e => e.type === 'span')).toBe(true)
  })
})

describe('B3 — PDFs with long sections render and keep every section', () => {
  const secs = (n: number, paras: number) => hydrateSections([], { language: 'en', paymentStructure: 'milestones' }).map((s: any) => {
    if (s.id === 'deliverables') s.table = Array.from({ length: n }, (_, i) => ({ deliverable: `Deliverable ${i}`, acceptanceCriteria: 'Accepted', owner: 'Provider', targetDate: '2026-11-01' }))
    else if (s.id === 'overview') s.content = Array.from({ length: paras }, (_, i) => `<p>Paragraph ${i} ${'words '.repeat(30)}</p>`).join('')
    else if (s.id === 'oos') s.content = '<ul>' + Array.from({ length: 25 }, (_, i) => `<li>Excluded ${i} ${'text '.repeat(20)}</li>`).join('') + '</ul>'
    else if (s.id === 'assumptions') s.content = '<p>' + 'long clause '.repeat(220) + '</p>'
    else if (!['timeline', 'roles', 'payment_schedule'].includes(s.id)) s.content = `<p>Body ${s.id}</p>`
    return s
  })
  const base = { agencyName: 'A', clientName: 'B', projectName: 'P', contractValue: 100, currency: 'USD', language: 'en', version: 1, isWatermarked: false, paymentStructure: 'milestones', paymentSchedule: [] }
  it.each([[4, 3], [30, 9], [45, 18]])('rows=%i paras=%i produces a PDF', async (n, paras) => {
    const buf = await renderSowPdf({ ...base, sections: secs(n, paras) } as any)
    expect(Buffer.from(buf).subarray(0, 4).toString()).toBe('%PDF')
  }, 60000)
  it('a signed SOW with a long milestone block renders', async () => {
    const sched = Array.from({ length: 16 }, (_, i) => ({ title: `M${i}`, amount: 100 + i, percentage: null, trigger: 'On delivery', dueDate: '2026-12-01', status: 'pending' }))
    const buf = await renderSowPdf({ ...base, sections: secs(5, 3), signedAt: '2026-10-01T10:00:00Z', signedBy: 'Bob', paymentSchedule: sched } as any)
    expect(Buffer.from(buf).subarray(0, 4).toString()).toBe('%PDF')
  }, 60000)
  it('the renderer no longer relies on minPresenceAhead for section headings', () => {
    const src = read('lib/pdf/renderer.tsx')
    const sowPart = src.slice(src.indexOf('function SectionShell'), src.indexOf('function SowDocument'))
    expect(sowPart).not.toMatch(/minPresenceAhead/)
    expect(src.slice(src.indexOf('function SowDocument'), src.indexOf('function SowDocument') + 12000)).not.toMatch(/minPresenceAhead/)
  })
})

describe('B4 — an amount written without a leading zero', () => {
  it('"$.50" is fifty cents, not fifty', () => {
    expect(p('$.50')).toBe(0.5)
    expect(p('.5')).toBe(0.5)
    expect(p('USD .75')).toBe(0.75)
  })
  it('existing readings are unchanged', () => {
    expect(p('$12.50')).toBe(12.5)
    expect(p('1,500')).toBe(1500)
    expect(p('0.5')).toBe(0.5)
    expect(p('Phase 1 5000')).toBeNull()
    expect(p('1.5k')).toBe(1500)
    expect(p('50%')).toBeNull()
  })
  it('prose amounts agree', () => {
    expect(amountsMentioned('A late fee of $.50 per day')).toEqual([0.5])
    expect(amountsMentioned('Pay 12,500.00 by day 14')).toEqual([12500, 14])
  })
})

describe('B5 — the AI table parser keeps real rows', () => {
  const raw = [
    '<<<TABLE:deliverables>>>',
    '(columns: Deliverable | Acceptance Criteria | Owner | Target Date — Owner must be exactly one of Provider, Client, or Joint)',
    '(Optional) Brand book | Signed off | Provider | Week 4',
    '(Phase 1) Design | work (initial) | Joint | 2 weeks (est)',
    '(a stray note wrapped entirely in parentheses)',
    'Copy deck | Reviewed | Client | Week 6 | and a literal | pipe',
    '<<<ENDTABLE>>>',
  ].join('\n')
  const rows = parseTableSections(raw).deliverables
  it('drops only the prompt echo and a fully parenthesised stray line', () => {
    expect(rows.map(r => r.deliverable)).toEqual(['(Optional) Brand book', '(Phase 1) Design', 'Copy deck'])
  })
  it('folds surplus cells into the last column instead of discarding them', () => {
    expect(rows[2].targetDate).toBe('Week 6 | and a literal | pipe')
  })
})

describe('B6 — a refused regenerate costs nothing', () => {
  it('the pending-approval pre-flight runs before the rate limit and the model call', () => {
    const src = read('app/api/sow/generate/route.ts')
    const probe = src.indexOf('draftProbe')
    expect(probe).toBeGreaterThan(-1)
    expect(probe).toBeLessThan(src.indexOf('checkAiRateLimit(service'))
    expect(probe).toBeLessThan(src.indexOf('recordAiUsage(service'))
    // the authoritative check against the freshly read draft is still there
    expect(src).toContain("getPendingApprovalForDocument(service, 'sow', existingSow.id)")
  })
})

describe('B7 — table select cells and plain-text cleaning', () => {
  it('an Owner / tick cell is always one of its options', () => {
    const [r] = sanitizeTableRows('deliverables', [{ deliverable: 'X', acceptanceCriteria: '', owner: 'Bogus', targetDate: '' }])
    expect(['Provider', 'Client', 'Joint']).toContain(r.owner)
    expect(sanitizeTableRows('deliverables', [{ deliverable: 'X', owner: 'provider' }])[0].owner).toBe('Provider')
    expect(sanitizeTableRows('deliverables', [{ deliverable: 'X', owner: '' }])[0].owner).toBe('Joint')
    const roles = sanitizeTableRows('roles', [{ responsibility: 'Design', provider: '', client: 'no', notes: '' }])[0]
    expect(roles.provider).toBe('—')
    expect(roles.client).toBe('—')
    expect(sanitizeTableRows('roles', [{ responsibility: 'Design', provider: '✓', client: '✓' }])[0].provider).toBe('✓')
  })
  it('an unterminated "<word" at the end of a cell keeps its text', () => {
    expect(sanitizePlainText('SLA<Premium')).toBe('SLA<Premium')
    expect(sanitizePlainText('x<y')).toBe('x<y')
    expect(sanitizePlainText('Response <24h')).toBe('Response <24h')
  })
  it('markup and attribute-carrying fragments are still removed', () => {
    expect(sanitizePlainText('<img src=x onerror=1')).toBe('')
    expect(sanitizePlainText('hi <script>alert(1)</script>')).not.toContain('<')
    expect(sanitizePlainText('<b>bold</b> text')).toBe('bold text')
    expect(sanitizePlainText('a<b')).toBe('a')
  })
})
