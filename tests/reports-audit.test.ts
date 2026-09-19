import { describe, it, expect } from 'vitest'
import { csvCell, csvRow } from '@/lib/utils/csv'
import { parsePeriod, periodSince } from '@/lib/reports/period'
import { buildAuditSearchFilter, escapeIlike, quotePostgrestValue } from '@/lib/audit/search'
import { redactMetadata, isMoneyKey, REDACTED } from '@/lib/audit/redact'
import { categoryFilter } from '@/lib/audit/categories'
import { fetchPaged } from '@/lib/utils/paginate'
import { buildCoGrid, classifyFlag, pickCurrency, isNonAdditiveAmendment } from '@/lib/reports/scope-financial-data'

describe('csvCell', () => {
  it('leaves real numbers alone, including negatives', () => {
    expect(csvCell(-500)).toBe('-500')
    expect(csvCell(-12.5)).toBe('-12.5')
    expect(csvCell(0)).toBe('0')
  })
  it('leaves plain signed-decimal strings alone', () => {
    expect(csvCell('-500')).toBe('-500')
    expect(csvCell('+12.5')).toBe('+12.5')
  })
  it('neutralises formula-leading strings, including tab and CR', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-cmd|x')).toBe("'-cmd|x")
    expect(csvCell('\t=1+1')).toBe("'\t=1+1")
    expect(csvCell('\r=1+1')).toBe(`"'\r=1+1"`)
  })
  it('applies RFC4180 quoting', () => {
    expect(csvCell('Acme, Inc')).toBe('"Acme, Inc"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
  it('csvRow joins cells', () => {
    expect(csvRow(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"')
  })
})

describe('parsePeriod / periodSince', () => {
  it('accepts the allowlist and defaults', () => {
    expect(parsePeriod('30d')).toBe('30d')
    expect(parsePeriod(null)).toBe('90d')
    expect(parsePeriod('')).toBe('90d')
    expect(parsePeriod('all')).toBe('all')
  })
  it('rejects unknown and inherited keys', () => {
    for (const bad of ['foo', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '7d']) {
      expect(parsePeriod(bad)).toBeNull()
    }
  })
  it('computes since deterministically', () => {
    const now = Date.UTC(2026, 8, 19)
    expect(periodSince('30d', now)).toBe(new Date(now - 30 * 86400000).toISOString())
    expect(periodSince('all', now)).toBe('2000-01-01T00:00:00Z')
  })
})

describe('audit search filter', () => {
  it('returns null for blank input', () => {
    expect(buildAuditSearchFilter('   ')).toBeNull()
  })
  it('double-quotes the value so commas and parens survive PostgREST', () => {
    const f = buildAuditSearchFilter('Acme, Inc (draft)')!
    expect(f).toContain('event_type.ilike."%Acme, Inc (draft)%"')
    expect(f).toContain('actor_email.ilike."%Acme, Inc (draft)%"')
  })
  it('escapes ILIKE wildcards, then the quoted-string layer', () => {
    expect(escapeIlike('50%_a\\b')).toBe('50\\%\\_a\\\\b')
    expect(quotePostgrestValue('say "x"\\')).toBe('"say \\"x\\"\\\\"')
    // "50%" must reach ILIKE as \% (a literal percent): ILIKE escape + quote escape doubles the backslash
    expect(buildAuditSearchFilter('50%')).toContain('"%50\\\\%%"')
  })
  it('caps length', () => {
    const f = buildAuditSearchFilter('x'.repeat(500))!
    expect(f.match(/x/g)!.length).toBe(100 * 5) // 100 chars in each of 5 columns
  })
})

describe('category filter', () => {
  it('builds a quoted LIKE or-list, null for unknown', () => {
    expect(categoryFilter('sow')).toBe('event_type.like."sow.%"')
    expect(categoryFilter('invoices')).toContain('event_type.like."payment.%"')
    expect(categoryFilter('nope')).toBeNull()
    expect(categoryFilter(undefined)).toBeNull()
  })
})

describe('redactMetadata', () => {
  it('passes everything through for financial viewers', () => {
    const m = { amount: 5, note: 'x' }
    expect(redactMetadata(m, true)).toEqual(m)
  })
  it('redacts legacy and money-shaped keys, including camelCase and nested', () => {
    const out = redactMetadata({
      amount: 100, balance_due: 5, contractValue: { from: 1, to: 2 }, newMonthlyAmount: 9,
      lines: [{ unit_price: 3, label: 'a' }], client_email: 'x@y.z', from: 'solo', to: 'agency', generated_at: 'now',
    }, false)!
    expect(out.amount).toBe(REDACTED)
    expect(out.balance_due).toBe(REDACTED)
    expect(out.contractValue).toBe(REDACTED)
    expect(out.newMonthlyAmount).toBe(REDACTED)
    expect((out.lines as any[])[0]).toEqual({ unit_price: REDACTED, label: 'a' })
    expect(out.client_email).toBe('x@y.z')
    expect(out.from).toBe('solo')
    expect(out.generated_at).toBe('now') // "rate" inside "generated" must not match
  })
  it('does not treat feedback / generated as money', () => {
    expect(isMoneyKey('feedback')).toBe(false)
    expect(isMoneyKey('generated_at')).toBe(false)
    expect(isMoneyKey('estimated_value')).toBe(true)
  })
  it('returns null for empty metadata', () => {
    expect(redactMetadata({}, false)).toBeNull()
    expect(redactMetadata(null, true)).toBeNull()
  })
})

describe('fetchPaged', () => {
  const makeSource = (n: number, cap: number) => {
    const all = Array.from({ length: n }, (_, i) => ({ id: i }))
    return async (from: number, to: number) => ({
      // simulate PostgREST max-rows: never returns more than `cap` rows
      data: all.slice(from, Math.min(to + 1, from + cap)),
      error: null, count: n,
    })
  }
  it('collects every row even when the server cap is below the page size', async () => {
    const res = await fetchPaged(makeSource(2500, 1000), { maxRows: 5000 })
    expect(res.rows.length).toBe(2500)
    expect(res.truncated).toBe(false)
  })
  it('still terminates and is complete when the cap is much smaller than pageSize', async () => {
    const res = await fetchPaged(makeSource(1234, 100), { maxRows: 5000 })
    expect(res.rows.length).toBe(1234)
    expect(res.total).toBe(1234)
  })
  it('flags truncation from the exact count', async () => {
    const res = await fetchPaged(makeSource(3000, 1000), { maxRows: 1500 })
    expect(res.rows.length).toBe(1500)
    expect(res.total).toBe(3000)
    expect(res.truncated).toBe(true)
  })
  it('throws on a query error instead of returning a short result', async () => {
    await expect(fetchPaged(async () => ({ data: null, error: { message: 'boom' } }), { maxRows: 10 })).rejects.toThrow('boom')
  })
  it('handles empty results', async () => {
    const res = await fetchPaged(makeSource(0, 1000), { maxRows: 10 })
    expect(res.rows).toEqual([])
    expect(res.truncated).toBe(false)
  })
})

describe('classifyFlag', () => {
  it('counts accepted-CO flags (resolved/change_order) as converted', () => {
    expect(classifyFlag({ status: 'resolved', resolution: 'change_order' }).converted).toBe(true)
    expect(classifyFlag({ status: 'converted_to_co', resolution: null }).converted).toBe(true)
    expect(classifyFlag({ status: 'resolved', resolution: 'exception' }).converted).toBe(false)
  })
  it('keeps dismissed and borderline flags out of the raised count', () => {
    expect(classifyFlag({ status: 'closed', resolution: 'not_out_of_scope' }).counted).toBe(false)
    expect(classifyFlag({ status: 'borderline_review', resolution: null }).counted).toBe(false)
    expect(classifyFlag({ status: 'open', resolution: null }).counted).toBe(true)
  })
})

describe('buildCoGrid', () => {
  const sent = '2026-09-01T00:00:00Z'
  it('reconciles: raised = accepted + declined + pending + closed', () => {
    const g = buildCoGrid([
      { id: '1', status: 'accepted', sent_at: sent },
      { id: '2', status: 'declined', sent_at: sent },
      { id: '3', status: 'awaiting_countersignature', sent_at: sent },
      { id: '4', status: 'expired', sent_at: sent },
      { id: '5', status: 'stalled', sent_at: sent },
      { id: '6', status: 'draft', sent_at: null },
      { id: '7', status: 'some_future_status', sent_at: sent },
    ])
    expect(g).toEqual({ raised: 6, accepted: 1, declined: 1, pending: 3, closed: 1 })
    expect(g.accepted + g.declined + g.pending + g.closed).toBe(g.raised)
  })
  it('counts a revision lineage once (drops the superseded parent)', () => {
    const g = buildCoGrid([
      { id: 'a', status: 'closed', sent_at: sent },
      { id: 'b', status: 'accepted', parent_co_id: 'a', sent_at: sent },
    ])
    expect(g.raised).toBe(1)
    expect(g.accepted).toBe(1)
  })
})

describe('currency helpers', () => {
  it('pickCurrency does not reorder availableCurrencies', () => {
    const r = pickCurrency({ USD: 2, EUR: 5, KES: 1 }, null)
    expect(r.availableCurrencies).toEqual(['EUR', 'KES', 'USD'])
    expect(r.currency).toBe('EUR')
    expect(r.mixedCurrencies).toBe(true)
    expect(pickCurrency({ USD: 2 }, 'KES').currency).toBe('USD')
    expect(pickCurrency({}, null).currency).toBe('USD')
  })
  it('flags only retainer-renewal amendments on retainer projects as non-additive', () => {
    expect(isNonAdditiveAmendment({ change_orders: { is_retainer_renewal: true } }, 'retainer')).toBe(true)
    expect(isNonAdditiveAmendment({ change_orders: { is_retainer_renewal: true } }, 'website')).toBe(false)
    expect(isNonAdditiveAmendment({ change_orders: { is_retainer_renewal: false } }, 'retainer')).toBe(false)
  })
})
