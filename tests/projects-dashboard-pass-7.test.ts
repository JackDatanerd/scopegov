// tests/projects-dashboard-pass-7.test.ts
//
// Projects & Dashboard (section 7) independent pass 7:
//   B1  the project page reads amendments with an explicit column list and ships a narrowed list to the browser
//       (select('*') carried previous_contract_value / pdf_path to viewers without VIEW_FINANCIALS)
//   B2  four handlers that were try/finally with no catch now surface a network / non-JSON failure
//   B3  "New CO" is only offered when the project has a signed SOW (POST /api/co refuses otherwise)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from)
  expect(a, `missing marker: ${from}`).toBeGreaterThan(-1)
  const b = s.indexOf(to, a + from.length)
  expect(b, `missing marker: ${to}`).toBeGreaterThan(a)
  return s.slice(a, b)
}

describe('B1 amendments are not shipped wholesale to the browser', () => {
  const page = src('app/(app)/projects/[id]/page.tsx')
  // Strip // comment lines so the guards test the query itself, not the prose explaining it.
  const query = between(page, "from('amendments')", '.order(').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('selects explicit columns, not *', () => {
    expect(query).not.toMatch(/select\('\*/)
    expect(query).toMatch(/select\('id, title, effective_at, added_deliverables, financial_impact, change_orders\(is_retainer_renewal\)'\)/)
  })
  it('never selects the prior rate or the storage path', () => {
    expect(query).not.toMatch(/previous_contract_value/)
    expect(query).not.toMatch(/pdf_path/)
  })
  it('the client-bound list is narrowed and still redacts financial_impact', () => {
    const mapping = between(page, 'const amendments = (amendmentsRaw', '// ── Fetch team members')
    expect(mapping).toMatch(/financial_impact: viewFinancials \? a\.financial_impact : null/)
    expect(mapping).not.toMatch(/\.\.\.a\b/)
    expect(mapping).not.toMatch(/change_orders/)
  })
  it('the contract maths still gets the renewal embed (unredacted input, gated output)', () => {
    expect(page).toMatch(/viewFinancials \? amendmentImpact\(amendmentsRaw, project\.type\) : null/)
  })
  it('every field the tabs render is still provided', () => {
    const detail = src('components/projects/ProjectDetail.tsx')
    for (const f of ['a.id', 'a.title', 'a.effective_at', 'a.added_deliverables', 'a.financial_impact']) expect(detail).toContain(f)
    expect(detail).not.toMatch(/a\.(previous_contract_value|pdf_path|signed_sow_id|change_order_id|removed_deliverables)/)
  })
})

describe('B2 handlers surface a network / non-JSON failure', () => {
  const s = src('components/projects/ProjectDetail.tsx')
  it('ScopeAdjustModal.submit has a catch that sets the error', () => {
    const fn = between(s, 'function ScopeAdjustModal', '// ── OVERVIEW TAB')
    expect(fn).toMatch(/\} catch \{\s*[\s\S]*?setError\('Could not save that adjustment/)
    expect(fn).toMatch(/\} finally \{ setBusy\(false\) \}/)
  })
  it('EscalateCoModal.submit has a catch that sets the error', () => {
    const fn = between(s, 'function EscalateCoModal', '// Must stay in sync with the status guard')
    expect(fn).toMatch(/\} catch \{\s*[\s\S]*?setError\('Could not escalate/)
  })
  it('TeamTab.addMember has a catch that sets the add error', () => {
    const fn = between(s, 'async function addMember', 'const [removeError')
    expect(fn).toMatch(/\} catch \{\s*[\s\S]*?setAddError\('Could not add that member/)
    expect(fn).toMatch(/\} finally \{ setAddingId\(null\) \}/)
  })
  it('Guardian history loadMore guards res.json(), checks res.ok and has a catch', () => {
    const fn = between(s, 'async function loadMore() {\n    if (!cursor) return', 'async function retryCheck')
    expect(fn).toMatch(/await res\.json\(\)\.catch\(/)
    expect(fn).toMatch(/!res\.ok \|\| json\.error/)
    expect(fn).toMatch(/\} catch \{/)
  })
  it('a failed load-more does not replace the already-loaded list (own error state, rendered under it)', () => {
    const fn = between(s, 'async function loadMore() {\n    if (!cursor) return', 'async function retryCheck')
    expect(fn).not.toMatch(/\bsetError\(/)
    expect(fn).toMatch(/setLoadMoreError\(/)
    expect(s).toMatch(/\{loadMoreError && <p /)
  })
})

describe('B3 New CO requires a signed SOW', () => {
  const s = src('components/projects/ProjectDetail.tsx')
  it('the header button is gated on hasSignedSow', () => {
    expect(s).toMatch(/permissions\.createCo && isActive && hasSignedSow && \(/)
  })
  it('the CO tab button is gated on the same flag, passed down as a prop', () => {
    expect(s).toMatch(/function CoTab\(\{[^}]*hasSignedSow[^}]*\}: any\)/)
    expect(s).toMatch(/<CoTab [^>]*hasSignedSow=\{hasSignedSow\}/)
    expect(s).toMatch(/\['Active', 'Stalled'\]\.includes\(project\.status\) && hasSignedSow && \(/)
  })
  it('the API still enforces it (so the gate mirrors a real rule)', () => {
    const co = src('app/api/co/route.ts')
    expect(co).toMatch(/This project has no signed SOW yet/)
  })
  it('hasSignedSow is derived from the signed status', () => {
    expect(s).toMatch(/const hasSignedSow = \(project\.sow_documents \|\| \[\]\)\.some\(\(s: any\) => s\.status === 'signed'\)/)
  })
})
