// tests/projects-dashboard-pass-8.test.ts
//
// Projects & Dashboard (section 7) independent pass 8:
//   B1  retrying a failed Guardian check refreshes the project when the retry creates a flag
//   B2  the new-project wizard refuses to enter Review with a contract value of 0 (the SOW generator refuses it)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from)
  expect(a, `missing marker: ${from}`).toBeGreaterThan(-1)
  const b = s.indexOf(to, a + from.length)
  expect(b, `missing marker: ${to}`).toBeGreaterThan(a)
  return s.slice(a, b)
}

describe('B1 check retry refreshes the flag list', () => {
  const detail = src('components/projects/ProjectDetail.tsx')
  it('the panel takes an onFlagCreated callback and the Guardian tab wires it to router.refresh', () => {
    expect(detail).toMatch(/function GuardianHistoryPanel\(\{ projectId, canRetry, onFlagCreated \}/)
    expect(detail).toMatch(/<GuardianHistoryPanel[^>]*onFlagCreated=\{\(\) => router\.refresh\(\)\}/)
  })
  it('retryCheck calls it only when the retry returned a flagId', () => {
    const fn = code(between(detail, 'async function retryCheck', 'return (\n    <div className="surface surface-p" style={{ marginBottom: 16 }}>'))
    expect(fn).toMatch(/if \(json\.flagId\) onFlagCreated\?\.\(\)/)
  })
  it('the retry route still returns flagId (the contract the refresh relies on)', () => {
    expect(code(src('app/api/guardian/checks/[id]/retry/route.ts'))).toMatch(/\bflagId,/)
  })
})

describe('B2 wizard checks the contract value before Review', () => {
  const wiz = src('app/(app)/projects/new/page.tsx')
  const fn = code(between(wiz, 'function goToReview()', 'async function handleBriefSubmit'))
  it('blocks a blank / zero value with a message and stays on the brief step', () => {
    expect(fn).toMatch(/!\(parseFloat\(contractValue\) > 0\)/)
    expect(fn).toMatch(/setError\(/)
    expect(fn.indexOf('setError(')).toBeLessThan(fn.indexOf('setStep(2)'))
  })
  it('clears a stale error when going Back to Basics', () => {
    expect(wiz).toMatch(/onClick=\{\(\) => \{ setError\(''\); setStep\(0\) \}\}/)
  })
  it('mirrors the server rule it is front-running', () => {
    expect(code(src('app/api/sow/generate/route.ts'))).toMatch(/!\(contractValue > 0\)/)
  })
})
