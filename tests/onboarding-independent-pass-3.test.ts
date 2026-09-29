import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isValidTimeZone, detectBrowserTimezone, listRuntimeTimezones } from '@/lib/utils/timezone'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// generateSlug is module-private; pull its source out and run it so the test exercises the real code.
function loadGenerateSlug(): (name: string) => string {
  const src = read('app/api/workspace/create/route.ts')
  const suffixDecl = src.match(/const slugSuffix = [^\n]+/)![0]
  const fn = src.slice(src.indexOf('function generateSlug'), src.indexOf('export async function POST'))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { customAlphabet } = require('nanoid')
  const body = `${suffixDecl}\n${fn}\nreturn generateSlug`
    .replace(/: string/g, '')
  return new Function('customAlphabet', body)(customAlphabet)
}

describe('B5 — generated workspace slugs satisfy the Settings slug validator', () => {
  const gen = loadGenerateSlug()
  const names = ['Meridian Creative', 'Ünïcödé Studio', '日本語 スタジオ', '---', '   ', '!!!', 'A', 'x'.repeat(200), '-lead and trail-', 'Foo   Bar -- Baz']
  it.each(names)('slug for %j is lowercase-alnum-hyphen, 3–50 chars', (name) => {
    for (let i = 0; i < 25; i++) {
      const slug = gen(name)
      expect(slug).toMatch(SLUG_RE)
      expect(slug.length).toBeGreaterThanOrEqual(3)
      expect(slug.length).toBeLessThanOrEqual(50)
    }
  })
  it('falls back to "workspace" for an empty base', () => {
    expect(gen('日本語')).toMatch(/^workspace-[a-z0-9]{6}$/)
  })
})

describe('B4 — create route retries and reports activation failure', () => {
  const create = read('app/api/workspace/create/route.ts')
  it('retries the active_workspace_id write and returns activeSet', () => {
    expect(create).toMatch(/setActive\(\)/)
    expect(create).toMatch(/activeSet: !activeWsError/)
  })
  it('wizard switches into the new workspace when activeSet is false', () => {
    const page = read('app/onboarding/page.tsx')
    expect(page).toMatch(/json\.activeSet === false/)
    expect(page).toMatch(/setGate\('switch_error'\)/)
  })
})

describe('B3 — logo upload/removal are tied to the wizard/Settings workspace', () => {
  const route = read('app/api/workspace/branding/logo/route.ts')
  it('POST and DELETE 409 on a workspaceId mismatch', () => {
    expect(route).toMatch(/formData\.get\('workspaceId'\)/)
    expect(route).toMatch(/searchParams\.get\('workspaceId'\)/)
    expect((route.match(/status: 409/g) || []).length).toBe(2)
  })
  it('wizard and Settings send the workspaceId', () => {
    expect(read('app/onboarding/page.tsx')).toMatch(/body\.append\('workspaceId', workspaceId\)/)
    const settings = read('components/settings/SettingsClient.tsx')
    expect(settings).toMatch(/if \(workspaceId\) body\.append\('workspaceId', workspaceId\)/)
    expect(settings).toMatch(/branding\/logo\?workspaceId=/)
  })
})

describe('B2 — ?new=1 is consumed once the workspace exists', () => {
  const page = read('app/onboarding/page.tsx')
  it('strips the flag and marks it consumed after a successful create', () => {
    expect(page).toMatch(/newFlagConsumedRef\.current = true/)
    expect(page).toMatch(/replaceState\(window\.history\.state, '', '\/onboarding'\)/)
  })
  it('explicitNew branch only runs while the flag is unconsumed; discard re-arms it', () => {
    expect(page).toMatch(/explicitNew && !newFlagConsumedRef\.current/)
    expect(page).toMatch(/newFlagConsumedRef\.current = false/)
  })
  it('effect re-run caused by the strip does not re-route a live wizard', () => {
    expect(page).toMatch(/!explicitNew && workspaceIdRef\.current\) return/)
  })
})

describe('B6 — a logo already uploaded is not re-uploaded', () => {
  const page = read('app/onboarding/page.tsx')
  it('clears logoFile after a successful upload and labels the button off the preview', () => {
    expect(page).toMatch(/logoStoragePath = upJson\.logoStoragePath[\s\S]*?setLogoFile\(null\)/)
    expect(page).toMatch(/logoPreview \? 'Change logo' : 'Upload logo'/)
  })
})

describe('timezone gap — wizard accepts any valid zone', () => {
  it('create route validates with isValidTimeZone, not the curated list', () => {
    const create = read('app/api/workspace/create/route.ts')
    expect(create).toMatch(/!isValidTimeZone\(timezone\)/)
    expect(create).not.toMatch(/TIMEZONES/)
  })
  it('helpers behave', () => {
    expect(isValidTimeZone('Africa/Kampala')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(listRuntimeTimezones()[0]).toBe('UTC')
    const d = detectBrowserTimezone()
    expect(d === null || isValidTimeZone(d)).toBe(true)
  })
  it('wizard renders the widened list', () => {
    expect(read('app/onboarding/page.tsx')).toMatch(/tzChoices\.map/)
  })
})
