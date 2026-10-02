// tests/projects-dashboard-pass-4.test.ts
//
// Projects & Dashboard (section 7) independent pass 4 — source-level regression guards (these handlers need a live
// Supabase / DOM, so the fixes are pinned by what the source must contain):
//   B1  complete route restores the open-group flags it closed when the borderline group fails
//   B2  POST /api/projects reports clientCreated; the wizard only renames a client it created
//   B3  members POST/DELETE reject a non-UUID memberId with 400
//   B4  message DELETE only flips (and audits) a row that is not already deleted
//   B5  discussion composer ignores Enter during IME composition
//   B6  ProjectDetail shell handlers tolerate a non-JSON error body
//   B7  insertMention uses a replacement function
//   B8  value bar partitions barTotal; credit COs are shown
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('B1 complete route — flag rollback', () => {
  const s = src('app/api/projects/[id]/complete/route.ts')
  it('only runs the borderline group when the open group succeeded', () => {
    expect(s).toMatch(/const borderlineErr = openErr \? null : await closeGroup\('borderline_review'/)
  })
  it('re-opens exactly the flags it closed, CAS-ing on its own close stamp', () => {
    expect(s).toMatch(/if \(borderlineErr\)/)
    expect(s).toMatch(/status: 'open', resolution: null, close_reason: null/)
    expect(s).toMatch(/\.eq\('status', 'closed'\)\.eq\('close_reason', closeReason\)\.eq\('resolved_at', now\)/)
  })
})

describe('B2 wizard client rename', () => {
  it('POST /api/projects returns whether it created the client', () => {
    const s = src('app/api/projects/route.ts')
    expect(s).toMatch(/let clientCreated = false/)
    expect(s).toMatch(/clientCreated = true/)
    expect(s).toMatch(/clientId: resolvedClientId, clientCreated \}/)
  })
  it('the wizard renames only a client it owns', () => {
    const s = src('app/(app)/projects/new/page.tsx')
    expect(s).toMatch(/createdClientOwned && trimmedName && trimmedName !== createdClientName/)
    expect(s).toMatch(/setCreatedClientOwned\(!clientId && json\.clientCreated === true\)/)
  })
})

describe('B3 members memberId validation', () => {
  it('rejects a non-UUID memberId on both POST and DELETE', () => {
    const s = src('app/api/projects/[id]/members/route.ts')
    expect(s.match(/if \(!isUuidString\(memberId\)\) return NextResponse\.json\(\{ error: 'Invalid memberId' \}, \{ status: 400 \}\)/g)?.length).toBe(2)
  })
})

describe('B4 message DELETE guard', () => {
  it('guards on deleted_at and skips the audit row when nothing changed', () => {
    const s = src('app/api/projects/[id]/messages/[messageId]/route.ts')
    const del = s.slice(s.indexOf('export async function DELETE'))
    expect(del).toMatch(/\.eq\('id', messageId\)\.is\('deleted_at', null\)\s*\.select\('id'\)/)
    expect(del).toMatch(/if \(!deleted \|\| deleted\.length === 0\) return NextResponse\.json\(\{ ok: true \}\)/)
    expect(del.indexOf('deleted.length === 0')).toBeLessThan(del.indexOf("eventType: 'project_message.deleted'"))
  })
})

describe('B5 / B7 discussion composer', () => {
  const s = src('components/projects/ProjectDiscussion.tsx')
  it('ignores keys pressed during IME composition', () => {
    expect(s).toMatch(/e\.nativeEvent\.isComposing \|\| e\.keyCode === 229/)
    expect(s.indexOf('isComposing')).toBeLessThan(s.indexOf("if (mentionActive) {\n                // Enter/Tab"))
  })
  it('inserts the mention label literally (replacement function, not a string)', () => {
    expect(s).toMatch(/upToCaret\.replace\(\/@\(\[\^\\s@\]\*\)\$\/, \(\) => `@\$\{label\} `\)/)
  })
})

describe('B6 / B8 ProjectDetail', () => {
  const s = src('components/projects/ProjectDetail.tsx')
  it('never throws a raw parse error from the shell handlers', () => {
    expect(s).not.toMatch(/if \(!res\.ok\) \{ const j = await res\.json\(\); throw new Error\(j\.error\) \}/)
    expect(s.match(/pass 4 — B6/g)?.length).toBe(4)
  })
  it('draws the value bar from segments that partition barTotal and shows credits', () => {
    expect(s).toMatch(/const committedBase = Math\.min\(baseValue, effectiveContractValue\)/)
    expect(s).toMatch(/flex: committedBase \/ barTotal/)
    expect(s).toMatch(/label="Credited"/)
  })
})
