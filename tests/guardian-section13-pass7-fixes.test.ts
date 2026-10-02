// tests/guardian-section13-pass7-fixes.test.ts
//
// Regression guards for Guardian / scope governance, independent pass 7:
//   B1 — flag.reopened / exception.edited / check.swept / check.flag_creation_failed had no activity label
//   B2 — an evidence filename cut at 200 UTF-16 units could strand half an emoji and fail the insert
//   B3 — a scope-adjustment rename could put one title in BOTH deliverables and out_of_scope
//   B4 — the escalation note's minimum length was measured before sanitising

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { describeActivity } from '@/lib/utils/activity-format'
import { stripUnstorableText, truncateText, sanitizePlainText } from '@/lib/utils/sanitize'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const row = (event_type: string, over: Record<string, unknown> = {}) =>
  ({ id: 'a1', event_type, entity_type: 'guardian_flag', entity_name: 'Acme site', actor_name: 'Jane', created_at: new Date().toISOString(), metadata: {}, ...over }) as any

describe('B1 — Guardian audit events read as sentences in the activity feeds', () => {
  it('flag.reopened and exception.edited name the actor and the action, not the raw event', () => {
    const reopened = describeActivity(row('flag.reopened'), { viewFinancials: false })
    expect(reopened).toEqual({ actor: 'Jane', text: 'reopened a scope flag' })
    const edited = describeActivity(row('exception.edited'), { viewFinancials: false })
    expect(edited).toEqual({ actor: 'Jane', text: 'corrected a scope exception' })
  })
  it('system pipeline events are standalone sentences (no "Guardian check swept")', () => {
    const swept = describeActivity(row('check.swept', { actor_name: 'Guardian' }), { viewFinancials: false })
    expect(swept.actor).toBe('')
    expect(swept.text).toBe('Guardian re-checked a queued message automatically')
    const failed = describeActivity(row('check.flag_creation_failed', { actor_name: 'Guardian' }), { viewFinancials: false })
    expect(failed.actor).toBe('')
    expect(failed.text.startsWith('Guardian could not save a scope flag')).toBe(true)
  })
  it('every event type the Guardian routes/pipeline log has a label', () => {
    const labelled = read('lib/utils/activity-format.ts')
    const logged = new Set<string>()
    for (const f of [
      'app/api/guardian/flags/[id]/route.ts', 'app/api/guardian/exceptions/[id]/route.ts', 'app/api/guardian/check/route.ts',
      'app/api/guardian/inbound/route.ts', 'app/api/guardian/scope-adjustment/route.ts', 'lib/ai/guardian-pipeline.ts',
      'app/api/cron/guardian-health/route.ts',
    ]) {
      for (const m of read(f).matchAll(/(?:eventType|auditEvent):\s*'([a-z_]+\.[a-z_]+)'/g)) logged.add(m[1])
      for (const m of read(f).matchAll(/markFailed\('([a-z_]+\.[a-z_]+)'/g)) logged.add(m[1])
    }
    expect(logged.size).toBeGreaterThan(10)
    for (const ev of logged) expect(labelled, `no activity label for ${ev}`).toContain(`'${ev}'`)
  })
})

describe('B2 — flag-evidence display name is cut without splitting a surrogate pair', () => {
  it('route uses truncateText + stripUnstorableText, not a bare slice', () => {
    const src = read('app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts')
    expect(src).toContain("import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'")
    expect(src).toContain('truncateText(stripUnstorableText(file.name.replace(')
    expect(src).not.toMatch(/file\.name\.replace\([^)]*\)\.slice\(0, 200\)/)
  })
  it('the helpers it relies on never leave a lone surrogate at the cut', () => {
    const name = 'a'.repeat(199) + '😀' + '.pdf'
    const cut = truncateText(stripUnstorableText(name), 200)
    expect(cut.length).toBe(199)
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false)
    expect(stripUnstorableText('bad\u0000name\uD83D.pdf')).toBe('badname\uFFFD.pdf')
  })
})

describe('B3 — scope-adjustment refuses a title that would sit in both lists', () => {
  const src = read('app/api/guardian/scope-adjustment/route.ts')
  it('checks the opposite list case-insensitively', () => {
    expect(src).toContain("(field === 'out_of_scope' ? snap.deliverables : snap.out_of_scope)")
    expect(src).toContain('titleOf(d).toLowerCase() === lower')
  })
  it('runs before the history row is written (nothing to roll back)', () => {
    expect(src.indexOf('otherList.some')).toBeGreaterThan(-1)
    expect(src.indexOf('otherList.some')).toBeLessThan(src.indexOf(".from('scope_adjustments').insert"))
  })
})

describe('B4 — escalation note is validated after sanitising', () => {
  const src = read('app/api/guardian/flags/[id]/route.ts')
  it('markup-only notes clean to nothing and are rejected', () => {
    expect(stripUnstorableText(sanitizePlainText('<b></b><b></b>   ')).trim().length).toBeLessThan(10)
    expect(stripUnstorableText(sanitizePlainText('<p>Please look at this today</p>')).trim().length).toBeGreaterThanOrEqual(10)
  })
  it('route measures safeNote, and defines it before the minimum check', () => {
    expect(src).toContain('if (safeNote.length < 10)')
    expect(src).not.toContain('if (escalationNote.length < 10)')
    expect(src.indexOf('const safeNote')).toBeLessThan(src.indexOf('if (safeNote.length < 10)'))
    expect(src.match(/const safeNote/g)?.length).toBe(1)
  })
})
