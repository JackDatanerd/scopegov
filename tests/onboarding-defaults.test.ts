import { describe, it, expect } from 'vitest'
import { TIMEZONES, CURRENCIES, DEFAULT_TIMEZONE, DEFAULT_CURRENCY } from '@/lib/constants/workspace-options'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('onboarding defaults', () => {
  it('defaults are members of the offered lists (so the dropdown shows what is stored)', () => {
    expect((TIMEZONES as readonly string[]).includes(DEFAULT_TIMEZONE)).toBe(true)
    expect((CURRENCIES as readonly string[]).includes(DEFAULT_CURRENCY)).toBe(true)
  })
  it('wizard and create route use the shared defaults, not hardcoded literals', () => {
    const page = readFileSync(join(process.cwd(), 'app/onboarding/page.tsx'), 'utf8')
    const create = readFileSync(join(process.cwd(), 'app/api/workspace/create/route.ts'), 'utf8')
    expect(page).not.toMatch(/America\/New_York/)
    expect(create).toMatch(/timezone \|\| DEFAULT_TIMEZONE/)
    expect(create).toMatch(/currency \|\| DEFAULT_CURRENCY/)
  })
})
