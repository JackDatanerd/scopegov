import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('new-project wizard entry points require CREATE_PROJECTS (pass 3, B1)', () => {
  it('/projects/new redirects members without CREATE_PROJECTS before the wizard renders', () => {
    const layout = read('app/(app)/projects/new/layout.tsx')
    expect(layout).toContain("hasPermission(session, 'CREATE_PROJECTS')")
    expect(layout).toContain("redirect('/projects')")
    expect(layout).toContain("redirect('/login')")
  })

  it('the SOW registry empty-state "New project" link is permission-gated', () => {
    const src = read('app/(app)/sow/page.tsx')
    const idx = src.indexOf('href="/projects/new"')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(Math.max(0, idx - 300), idx)).toContain("hasPermission(session, 'CREATE_PROJECTS')")
  })
})
