// tests/settings-fresh-pass-revision-rounds.test.ts
//
// Settings fresh pass: the saved default revision-rounds range must be exactly what the SOW
// pipeline can honour (1-10). It used to be 0-20, and /api/sow/generate silently turned
// 0 and 11-20 into 2 rounds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('default revision rounds are bounded to 1-10 everywhere', () => {
  const route = read('app/api/workspace/defaults/route.ts')
  it('defaults route enforces 1..10', () => {
    expect(route).toMatch(/const REVISION_ROUNDS_MIN = 1\b/)
    expect(route).toMatch(/const REVISION_ROUNDS_MAX = 10\b/)
    expect(route).toMatch(/n < REVISION_ROUNDS_MIN \|\| n > REVISION_ROUNDS_MAX/)
  })
  it('Settings dropdown offers 1-10, not 0-20', () => {
    const src = read('components/settings/SettingsClient.tsx')
    expect(src).toMatch(/Array\.from\(\{ length: 10 \}, \(_, i\) => String\(i \+ 1\)\)/)
    expect(src).not.toMatch(/length: 21/)
  })
  it('New Project dropdown and AI-brief clamp cover 1-10', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect(src).toMatch(/\['1','2','3','4','5','6','7','8','9','10'\]/)
    expect(src).toMatch(/parsedBriefRounds >= 1 && parsedBriefRounds <= 10/)
  })
  it('SOW generation clamp still matches (1-10)', () => {
    expect(read('app/api/sow/generate/route.ts')).toMatch(/parsedRounds >= 1 && parsedRounds <= 10/)
  })
  it('migration 130 clamps legacy rows and adds the CHECK', () => {
    const sql = read('supabase/migrations/130_workspace_defaults_revision_rounds_range.sql')
    expect(sql).toMatch(/LEAST\(GREATEST\(revision_rounds, 1\), 10\)/)
    expect(sql).toMatch(/CHECK \(revision_rounds IS NULL OR revision_rounds BETWEEN 1 AND 10\)/)
  })
})
