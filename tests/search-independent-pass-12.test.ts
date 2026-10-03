import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

// Round 12: the sidebar's Invoices link must be gated like the page behind it, and the palette's row hover must not
// steal keyboard selection.
describe('sidebar Invoices link (round 12)', () => {
  const sidebar = read('components/layout/Sidebar.tsx')
  const invoicesPage = read('app/(app)/invoices/page.tsx')
  const palette = read('components/layout/CommandPalette.tsx')

  it('the invoices page redirects people without VIEW_FINANCIALS', () => {
    expect(invoicesPage).toMatch(/!hasPermission\(session, 'VIEW_FINANCIALS'\)\) redirect\('\/dashboard'\)/)
  })

  it('the sidebar entry carries the same permission', () => {
    const line = sidebar.split('\n').find(l => l.includes("href: '/invoices'"))
    expect(line).toBeDefined()
    expect(line).toContain("permission: 'VIEW_FINANCIALS'")
  })

  it('the sidebar and the palette quick-nav gate Invoices on the same permission', () => {
    expect(palette).toMatch(/permissions\.includes\('VIEW_FINANCIALS'\)[\s\S]{0,80}href: '\/invoices'/)
  })
})

describe('command palette row hover (round 12)', () => {
  const palette = read('components/layout/CommandPalette.tsx')

  it('result rows move the selection on mousemove, not mouseenter', () => {
    const optionBlock = palette.slice(palette.indexOf('role="option"'), palette.indexOf('ti-arrow-right'))
    expect(optionBlock).toMatch(/onMouseMove=\{/)
    expect(optionBlock).not.toMatch(/onMouseEnter=\{/)
  })
})
