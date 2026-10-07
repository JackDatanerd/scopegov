import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('Projects & Dashboard pass 16', () => {
  it('dashboard subscription tile pluralises days remaining', () => {
    const s = read('app/(app)/dashboard/page.tsx')
    expect(s).toContain("day${daysLeft === 1 ? '' : 's'} remaining")
  })
  it('guardian tab only offers the forward-to address while monitoring is live', () => {
    const s = read('components/projects/ProjectDetail.tsx')
    expect(s).toContain('{isActive && project.guardian_email && (')
    expect(s).not.toContain('you can still check content against the signed scope via')
  })
  it('wizard defaults fetch reads touched flags through refs', () => {
    const s = read('app/(app)/projects/new/page.tsx')
    expect(s).toContain('!currencyTouchedRef.current')
    expect(s).toContain('!defaultsTouchedRef.current')
  })
})
