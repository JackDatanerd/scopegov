import { describe, it, expect } from 'vitest'
import { TIMEZONES, CURRENCIES, DEFAULT_TIMEZONE, DEFAULT_CURRENCY } from '@/lib/constants/workspace-options'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('onboarding defaults', () => {
  it('default timezone is UTC and is the first option offered', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC')
    expect(TIMEZONES[0]).toBe('UTC')
  })
  it('defaults are members of the offered lists (so the dropdown shows what is stored)', () => {
    expect((TIMEZONES as readonly string[]).includes(DEFAULT_TIMEZONE)).toBe(true)
    expect((CURRENCIES as readonly string[]).includes(DEFAULT_CURRENCY)).toBe(true)
  })
  it('wizard, create route and resume payload use the shared defaults, not literals', () => {
    const page = read('app/onboarding/page.tsx')
    const create = read('app/api/workspace/create/route.ts')
    const status = read('app/api/workspace/onboarding-status/route.ts')
    expect(page).not.toMatch(/America\/New_York/)
    expect(create).toMatch(/timezone \|\| DEFAULT_TIMEZONE/)
    expect(create).toMatch(/currency \|\| DEFAULT_CURRENCY/)
    expect(status).toMatch(/w\.timezone \|\| DEFAULT_TIMEZONE/)
    expect(status).not.toMatch(/America\/New_York/)
  })
})
