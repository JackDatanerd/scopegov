import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

describe('lapsed workspace plan display (c7 B1)', () => {
  it('dashboard Subscription tile does not call a lapsed workspace Solo / Active', () => {
    const src = readFileSync('app/(app)/dashboard/page.tsx', 'utf8')
    expect(src).toMatch(/session\.lapsed \? 'No plan'/)
    expect(src).toMatch(/session\.lapsed \? 'Read-only/)
  })
  it('sidebar plan tag follows session.lapsed', () => {
    const src = readFileSync('components/layout/Sidebar.tsx', 'utf8')
    expect(src).toMatch(/session\.lapsed \? 'No plan/)
  })
})
