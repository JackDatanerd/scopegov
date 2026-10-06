import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('Projects & Dashboard independent pass 13', () => {
  it('B1: PATCH refuses a contract value / retainer term change without VIEW_FINANCIALS', () => {
    const src = read('app/api/projects/[id]/route.ts')
    expect(src.match(/Missing permission: VIEW_FINANCIALS/g)?.length).toBe(2)
    const cv = src.indexOf('newValue !== Number(project.contract_value)')
    expect(src.slice(cv, cv + 600)).toContain("hasPermission(session, 'VIEW_FINANCIALS')")
  })
  it('B1: the edit modal hides and never sends the retainer term without financials', () => {
    const src = read('components/projects/EditProjectModal.tsx')
    expect(src).toContain("canViewFinancials && type === 'retainer' && !valueLocked")
    expect(src).toContain("type === 'retainer' && canViewFinancials && (")
  })
  it('B2: the milestones card is only rendered with VIEW_FINANCIALS', () => {
    expect(read('components/projects/ProjectDetail.tsx')).toContain('{permissions.viewFinancials && <div className="surface surface-p">')
  })
  it('B3: activity load-more pages by the server offset, not the de-duplicated row count', () => {
    const src = read('components/projects/ProjectDetail.tsx')
    expect(src).toContain('activity?offset=${offsetRef.current}')
    expect(src).toContain('offsetRef.current += (json.rows || []).length')
  })
})
