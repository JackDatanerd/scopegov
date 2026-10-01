import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { generateSlug } from '@/lib/utils/workspace-slug'

// Regression coverage for the Onboarding independent pass (round 9) — three low-severity items.
//   B1  An invite refused for seats in the wizard said "upgrade in Settings → Billing", a page the
//       wizard's creator can't reach until setup finishes (expired-trial workspace = Solo = 1 seat).
//   B2  The handle was generated once from the first-typed agency name and never followed a rename
//       made on Back, so a typo stayed in the handle that report filenames read back.
//   B3  The agency-name input had no maxLength, so a name over 120 characters was cut silently.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('B1 wizard translates a seat-limit refusal into something actionable', () => {
  const page = read('app/onboarding/page.tsx')
  it('handles upgradeRequired before falling back to the route message', () => {
    expect(page).toMatch(/if \(json\.upgradeRequired\) \{\s*setError\(/)
    expect(page.indexOf('json.upgradeRequired')).toBeLessThan(page.indexOf("Could not send that invite"))
  })
  it('tells the person to skip now and upgrade/invite after setup', () => {
    expect(page).toMatch(/Skip this step[^']*once setup is finished you can upgrade in Settings/)
  })
})

describe('B2 the auto-generated handle follows a rename while onboarding is unfinished', () => {
  const route = read('app/api/workspace/settings/route.ts')
  it('reads onboarding_completed_at alongside slug_changed_at', () => {
    expect(route).toMatch(/slug_changed_at, onboarding_completed_at, updated_at/)
  })
  it('regenerates only for an unfinished workspace whose handle was never set by a person', () => {
    expect(route).toMatch(/changedKeys\.includes\('name'\) && !\('slug' in proposed\) &&\s*!current\.onboarding_completed_at && !current\.slug_changed_at/)
    expect(route).toMatch(/updates\.slug = generateSlug\(proposed\.name\)/)
  })
  it('does not stamp slug_changed_at for the automatic change (no burned free change / cooldown)', () => {
    const block = route.slice(route.indexOf('let autoSlug = false'), route.indexOf('FIX (independent re-audit, Settings section'))
    expect(block).not.toMatch(/slug_changed_at\s*=/)
  })
  it('retries once with a fresh suffix on a unique-violation of the auto handle', () => {
    expect(route).toMatch(/error as any\)\.code === '23505' && autoSlug/)
  })
  it('create and settings share one generator, and its output still satisfies the Settings validator', () => {
    expect(read('app/api/workspace/create/route.ts')).toContain("from '@/lib/utils/workspace-slug'")
    expect(route).toContain("from '@/lib/utils/workspace-slug'")
    for (const n of ['Meridian Creative', 'Meridan Creative', '日本語', '---', 'A'.repeat(200)]) {
      const slug = generateSlug(n)
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(slug.length).toBeLessThanOrEqual(50)
    }
  })
  it('a rename produces a handle derived from the new name', () => {
    expect(generateSlug('Meridian Creative')).toMatch(/^meridian-creative-[a-z0-9]{6}$/)
  })
})

describe('B3 wizard inputs carry the server limits', () => {
  const page = read('app/onboarding/page.tsx')
  it('agency name is capped at 120, governing law at 200, invite email at 254', () => {
    expect(page).toMatch(/placeholder="Meridian Creative" autoFocus required maxLength=\{120\}/)
    expect(page).toMatch(/value=\{governingLaw\} maxLength=\{200\}/)
    expect(page).toMatch(/value=\{inviteEmail\} autoFocus maxLength=\{254\}/)
  })
})
