// tests/guardian-section13-pass4-fixes.test.ts
//
// Regression guards for Guardian / scope governance, independent pass 4:
//   B1 - a deliverable removed by a credit/descope CO was still listed to the classifier as CO-added (covered_by_co)
//   B2 - a forward whose body is ">"-quoted lost the client's request entirely
//   B3 - a wrapped "On ... / ... wrote:" shape with no date/address cut an ordinary request to ""
//   B4 - toPlainText decoded only six entities, in an order that double-decoded
//   B5 - the sweep read the 40 oldest rows and filtered backoff afterwards, starving due rows

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'

const captured: any[] = []
vi.mock('@/lib/ai/guardian', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    classifyGuardianCheck: vi.fn(async (args: any) => {
      captured.push(args)
      return {
        outcome: 'out_of_scope', matchConfidence: 0.1, creepConfidence: 0.95,
        matchedAgainst: null, matchedReference: 'x', reasoning: 'r',
      }
    }),
  }
})

import { netAmendmentDeliverables, toPlainText, decodeEntities } from '@/lib/ai/guardian'
import { extractUnquotedContent } from '@/lib/ai/guardian-email'
import {
  classifyAndRecord, GUARDIAN_SYSTEM_ACTOR, sweepAttemptCutoffs, sweepDueFilter, isSweepDue,
  MAX_AUTO_CLASSIFICATION_ATTEMPTS, GUARDIAN_SWEEP_BACKOFF_BASE_MS, GUARDIAN_LIVE_PATH_GRACE_MS,
} from '@/lib/ai/guardian-pipeline'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('B1 - net CO-added deliverables', () => {
  const co1 = { id: 'co1', title: 'CO1', added_deliverables: ['Mobile app', 'Blog'], removed_deliverables: [], created_at: '2026-01-01T00:00:00Z' }
  const credit = { id: 'co2', title: 'Credit', added_deliverables: [], removed_deliverables: ['mobile APP '], created_at: '2026-02-01T00:00:00Z' }
  const rebuy = { id: 'co3', title: 'Rebuy', added_deliverables: ['Mobile app'], removed_deliverables: [], created_at: '2026-03-01T00:00:00Z' }

  it('drops an add that a LATER credit CO removed (case/space-insensitive), keeps the rest', () => {
    const net = netAmendmentDeliverables([co1, credit])
    expect(net).toHaveLength(1)
    expect(net[0].added_deliverables).toEqual(['Blog'])
  })
  it('keeps a deliverable bought again after the removal', () => {
    const net = netAmendmentDeliverables([co1, credit, rebuy])
    expect(net.map(a => a.id)).toEqual(['co1', 'co3'])
    expect(net.find(a => a.id === 'co1')!.added_deliverables).toEqual(['Blog'])
    expect(net.find(a => a.id === 'co3')!.added_deliverables).toEqual(['Mobile app'])
  })
  it('input order does not matter - created_at decides', () => {
    expect(netAmendmentDeliverables([credit, co1]).map(a => a.added_deliverables)).toEqual([['Blog']])
  })
  it('an amendment left with nothing is dropped, so "no amendments" is what the classifier sees', () => {
    const only = { ...co1, added_deliverables: ['Mobile app'] }
    expect(netAmendmentDeliverables([only, credit])).toEqual([])
  })
  it('a removal that PRECEDES the add does not cancel it', () => {
    const earlyCredit = { ...credit, created_at: '2025-12-01T00:00:00Z' }
    expect(netAmendmentDeliverables([earlyCredit, co1])[0].added_deliverables).toEqual(['Mobile app', 'Blog'])
  })
  it('rows without removed_deliverables / created_at (old shape) pass through unchanged', () => {
    const old = [{ id: 'a', title: 'A', added_deliverables: ['X'] }]
    expect(netAmendmentDeliverables(old)).toEqual(old)
  })

  it('classifyAndRecord hands the classifier only the net list', async () => {
    captured.length = 0
    const fake = createFakeSupabase({
      guardian_checks: [{ id: 'chk1', project_id: 'p1', workspace_id: 'w1', outcome: 'pending', flag_id: null, classification_failed: false }],
      guardian_flags: [],
      amendments: [
        { project_id: 'p1', ...co1 },
        { project_id: 'p1', ...credit },
      ],
    })
    await classifyAndRecord(fake.client as any, {
      check: { id: 'chk1', content: 'Please build the mobile app' },
      project: { id: 'p1', name: 'Acme', workspace_id: 'w1' },
      snapshot: { deliverables: [{ title: 'Website' }], out_of_scope: [{ title: 'Mobile app' }] },
      sensitivity: 'medium', actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.classified', emailPath: 'paste',
    } as any)
    expect(captured).toHaveLength(1)
    expect(captured[0].amendments.flatMap((a: any) => a.added_deliverables)).toEqual(['Blog'])
  })
  it('the amendments read selects the columns the net computation needs', () => {
    const src = read('lib/ai/guardian-pipeline.ts')
    expect(src).toMatch(/select\('id, title, added_deliverables, removed_deliverables, created_at'\)/)
    expect(src).toContain('netAmendmentDeliverables(data || [])')
  })
})

describe('B2 - forwarded, ">"-quoted bodies keep the client request', () => {
  const apple = 'FYI, can we do this?\n\nBegin forwarded message:\n\n> From: Client <c@x.com>\n> Subject: New req\n> Date: Monday\n> To: me\n>\n> Please also add SSO login and a Spanish version.\n'
  it('keeps the quoted forwarded body and drops its header block', () => {
    const out = extractUnquotedContent(apple, { isForward: true })
    expect(out).toContain('Please also add SSO login and a Spanish version.')
    expect(out).toContain('FYI, can we do this?')
    expect(out).not.toMatch(/Subject:|From:/)
  })
  it('a forward with nothing but quoted lines is no longer empty', () => {
    expect(extractUnquotedContent('Begin forwarded message:\n\n> From: C <c@x.com>\n> Subject: s\n>\n> Please add SSO login.\n', { isForward: true }))
      .toBe('Please add SSO login.')
  })
  it('a deeper quote level inside a forward (earlier thread) is still dropped', () => {
    const out = extractUnquotedContent('FYI\n\n> Add SSO please\n>\n> > old handled request about logo\n', { isForward: true })
    expect(out).toContain('Add SSO please')
    expect(out).not.toContain('logo')
  })
  it('replies are unchanged: quoted lines are dropped', () => {
    expect(extractUnquotedContent('Sure, add dark mode.\n\n> old quoted line\n> more')).toBe('Sure, add dark mode.')
  })
  it('an unquoted Gmail-style forward still works', () => {
    const out = extractUnquotedContent('FYI\n\n---------- Forwarded message ---------\nFrom: C <c@x.com>\nDate: Mon\nSubject: s\nTo: me\n\nPlease add SSO login', { isForward: true })
    expect(out).toContain('Please add SSO login')
    expect(out).not.toContain('Subject:')
  })
})

describe('B3 - a wrapped attribution needs a date or address', () => {
  it('ordinary prose that merely matches the two line shapes is kept', () => {
    expect(extractUnquotedContent('On the homepage we need a banner\nMy colleague wrote:\nplease add chat widget'))
      .toBe('On the homepage we need a banner\nMy colleague wrote:\nplease add chat widget')
  })
  it('a real wrapped Gmail attribution still cuts the quoted thread', () => {
    expect(extractUnquotedContent('Add Spanish.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Bob Smith <bob.smith@example.com>\nwrote:\n> old')).toBe('Add Spanish.')
    expect(extractUnquotedContent('Add Spanish.\n\nOn Mon, Sep 1, 2026 at 10:00 AM\nBob <b@x.com> wrote:\n> old')).toBe('Add Spanish.')
  })
  it('a one-line attribution still cuts', () => {
    expect(extractUnquotedContent('Add Spanish.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Bob <b@x.com> wrote:\n> old')).toBe('Add Spanish.')
  })
})

describe('B4 - toPlainText entity decoding', () => {
  it('decodes numeric, hex and common named entities in one pass', () => {
    expect(toPlainText('<p>It&#8217;s caf&eacute; &ndash; r&#x27;s &#160;ok</p>')).toBe('It\u2019s caf\u00E9 \u2013 r\'s ok')
  })
  it('does not double-decode: &amp;lt; stays the literal text "&lt;"', () => {
    expect(toPlainText('<p>use &amp;lt;b&amp;gt;</p>')).toBe('use &lt;b&gt;')
  })
  it('leaves unknown names and invalid code points as written', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800; &#99999999;')).toBe('&bogus; &#0; &#xD800; &#99999999;')
  })
  it('plain-text input is untouched', () => {
    expect(toPlainText('Tom &amp; Jerry < 5')).toBe('Tom &amp; Jerry < 5')
  })
})

describe('B5 - sweep due-ness is in the query', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z')
  it('one bucket per attempt count with doubling backoff', () => {
    const b = sweepAttemptCutoffs(NOW)
    expect(b).toHaveLength(MAX_AUTO_CLASSIFICATION_ATTEMPTS)
    b.forEach((c, i) => {
      expect(c.attempts).toBe(i)
      expect(NOW - Date.parse(c.attemptedBefore)).toBe(GUARDIAN_SWEEP_BACKOFF_BASE_MS * 2 ** i)
      expect(NOW - Date.parse(c.createdBefore)).toBe(GUARDIAN_LIVE_PATH_GRACE_MS)
    })
  })
  it('the filter selects attempted-and-elapsed OR never-attempted-and-past-grace', () => {
    const f = sweepDueFilter(sweepAttemptCutoffs(NOW)[0])
    expect(f).toMatch(/^last_attempt_at\.lte\..+,and\(last_attempt_at\.is\.null,created_at\.lte\..+\)$/)
  })
  it('isSweepDue agrees with the filter boundaries', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    expect(isSweepDue({ last_attempt_at: null, created_at: iso(NOW - 5 * 60000) }, NOW)).toBe(false)
    expect(isSweepDue({ last_attempt_at: null, created_at: iso(NOW - GUARDIAN_LIVE_PATH_GRACE_MS) }, NOW)).toBe(true)
    expect(isSweepDue({ last_attempt_at: iso(NOW - 20 * 60000), created_at: iso(NOW - 3600000), classification_attempts: 1 }, NOW)).toBe(false)
    expect(isSweepDue({ last_attempt_at: iso(NOW - 31 * 60000), created_at: iso(NOW - 3600000), classification_attempts: 1 }, NOW)).toBe(true)
  })
  it('the cron route queries per bucket and no longer slices a 40-row oldest-first window', () => {
    const src = read('app/api/cron/guardian-health/route.ts')
    expect(src).toContain('sweepAttemptCutoffs(now)')
    expect(src).toContain('.or(sweepDueFilter(c))')
    expect(src).toContain(".eq('classification_attempts', c.attempts)")
    expect(src).not.toMatch(/\.limit\(40\)/)
  })
})
