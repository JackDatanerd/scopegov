import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Regression coverage for Onboarding independent pass 6 (source-level, like the earlier passes).
//   M1  offline restore (status fetch failed) showed "add a governing law" although the server's value is unknown
//   M2  discard left the previous "recently deleted" list on screen until the refetch returned
//   M3  waiting-screen poll ignored a switch to a different waiting workspace

const src = readFileSync(join(process.cwd(), 'app/onboarding/page.tsx'), 'utf8')

describe('onboarding pass 6', () => {
  it('M1: warning is suppressed while the saved governing law is unknown, and cleared once known', () => {
    expect(src).toContain('const [savedLawUnknown, setSavedLawUnknown] = useState(false)')
    expect(src).toMatch(/setSavedLawUnknown\(true\)/)
    expect(src).toContain('!savedGoverningLaw.trim() && !savedLawUnknown')
    expect(src.match(/setSavedLawUnknown\(false\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
  it('M2: discard clears the restorable list', () => {
    const i = src.indexOf('setOtherWorkspaces([])\n      setRestorable([])')
    expect(i).toBeGreaterThan(-1)
  })
  it('M3: waiting poll reloads when the waiting workspace changes', () => {
    expect(src).toContain('json.workspaceId !== waitingFor.workspaceId')
    expect(src).toContain('}, [gate, waitingFor?.workspaceId])')
  })
})
