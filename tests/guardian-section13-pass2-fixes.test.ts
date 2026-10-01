// tests/guardian-section13-pass2-fixes.test.ts
//
// Regression guards for Guardian / scope governance, independent pass 2:
//   G1 — toPlainText ran three backtracking regexes over the WHOLE inbound email body (quadratic on unclosed tags)
//   G2 — the health sweep could classify a check a live request still owned -> two flags / two emails
//   G3 — a sweep that threw still recorded a healthy heartbeat and paged nobody
//   G4 — read failures answered as "empty" / "not found" on the governance + Guardian read routes
//   G5 — reopen / escalate / confirm / exception / scope-adjustment worked on Complete / Archived projects

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('@/lib/ai/guardian', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    classifyGuardianCheck: vi.fn(async () => ({
      outcome: 'out_of_scope', matchConfidence: 0.1, creepConfidence: 0.95,
      matchedAgainst: null, matchedReference: 'Deliverable A', reasoning: 'Beyond the agreed scope.',
    })),
  }
})

import { toPlainText, MAX_PLAINTEXT_INPUT_CHARS } from '@/lib/ai/guardian'
import { classifyAndRecord, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

// The implementation this pass replaced, kept verbatim as the oracle: on every ordinary input the linear scanner must
// produce exactly what these regexes did.
const OLD_HINT = /<\/?(?:html|body|head|div|p|br|span|a|table|tbody|thead|tr|td|th|ul|ol|li|h[1-6]|strong|em|b|i|u|img|blockquote|pre|code|style|script|font|center)(?:\s[^>]*)?\/?>/i
const OLD_ANY = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g
function oldToPlainText(content: string): string {
  let text = String(content ?? '')
  if (OLD_HINT.test(text)) {
    text = text
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(OLD_ANY, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  }
  return text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

describe('G1 — toPlainText is linear and unchanged on ordinary input', () => {
  const corpus = [
    'plain text with no markup at all',
    'page load time < 2s and error rate > 1%',
    'Reach me at <jane@acme.com> or <3 me',
    '<p>Hi team,</p><p>Please add a <b>dark mode</b> toggle.</p><br/>Thanks',
    '<div class="x" style="color:red">Hello&nbsp;there &amp; welcome</div>',
    '<html><head><style>p{color:red}</style><script type="text/javascript">alert(1)</script></head><body>Body text</body></html>',
    '<STYLE>a{}</STYLE>after<SCRIPT>x()</SCRIPT>tail',
    '<ul><li>one</li><li>two</li></ul><table><tr><td>cell</td></tr></table>',
    '<a href="https://example.com/a?b=1&c=2">link</a> and <img src="x.png" alt="pic"/>',
    '<blockquote>quoted</blockquote>reply <span>inline</span>',
    'line1\r\nline2\r\n\r\n\r\n\r\nline3 &lt;tag&gt; &quot;q&quot; &#39;s&#39;',
    '<p>unclosed <a href="x" and then text',
    '<style>never closed p{} text after',
    '<p>ok</p><style>never closed',
    '<custom-tag data-x="1">custom</custom-tag> and <x> and </y >',
    '<a x <b>nested weird</b>',
    '<img\nsrc="x"\n/>multi-line tag',
    'Ünïcödé <p>héllo</p> wörld',
    '<br><br><br>many breaks<br />',
    '',
  ]
  for (const [i, input] of corpus.entries()) {
    it(`matches the previous output on sample ${i + 1}`, () => {
      expect(toPlainText(input)).toBe(oldToPlainText(input))
    })
  }

  const hostile: Array<[string, string]> = [
    ['unclosed tag starts', '<a x '],
    ['unclosed style blocks', '<style>'],
    ['unclosed script with attrs', '<script type="x"> '],
    ['unclosed closing tags', '</a x '],
    ['tag-like without whitespace', '<a@b.c <a@b.c '],
  ]
  for (const [label, unit] of hostile) {
    it(`stays fast on ${label} (a 4 MB body used to take minutes)`, () => {
      const body = '<p>hi</p>' + unit.repeat(Math.ceil(4_000_000 / unit.length))
      const t = Date.now()
      const out = toPlainText(body)
      expect(Date.now() - t).toBeLessThan(2000)
      expect(out.startsWith('hi')).toBe(true)
    })
  }

  it('bounds how much of a body it will look at', () => {
    const out = toPlainText('x'.repeat(MAX_PLAINTEXT_INPUT_CHARS + 500))
    expect(out.length).toBe(MAX_PLAINTEXT_INPUT_CHARS)
  })
})

describe('G2 — one flag per check, and the sweep leaves live requests alone', () => {
  const project = { id: 'p1', name: 'Proj', workspace_id: 'w1' }
  const snapshot = { deliverables: [{ title: 'Deliverable A' }], out_of_scope: [] }
  const base = () => ({
    check: { id: 'chk1', content: 'Please also build a mobile app' },
    project, snapshot, sensitivity: 'medium' as const,
    actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.swept', emailPath: 'automatic re-check',
  })
  const uniqueCheckId = (table: string, row: any, existing: any[]) =>
    table === 'guardian_flags' && row.check_id != null && existing.some(r => r.check_id === row.check_id)

  it('a second classification of an already-flagged check links the existing flag instead of failing or duplicating', async () => {
    const fake = createFakeSupabase({
      guardian_checks: [{ id: 'chk1', project_id: 'p1', workspace_id: 'w1', outcome: 'pending', flag_id: null, classification_failed: false }],
      guardian_flags: [{ id: 'flag-winner', check_id: 'chk1', project_id: 'p1', workspace_id: 'w1', status: 'open' }],
      amendments: [],
    }, { unique: uniqueCheckId })

    const res = await classifyAndRecord(fake.client as any, base())

    expect(res.status).toBe('classified')
    expect((res as any).flagId).toBe('flag-winner')
    expect(fake.tables.guardian_flags).toHaveLength(1)
    const check = fake.tables.guardian_checks.find((r: any) => r.id === 'chk1')!
    expect(check.flag_id).toBe('flag-winner')
    expect(check.classification_failed).toBe(false) // not bounced into the retry loop
  })

  it('the first classification still creates the flag', async () => {
    const fake = createFakeSupabase({
      guardian_checks: [{ id: 'chk1', project_id: 'p1', workspace_id: 'w1', outcome: 'pending', flag_id: null, classification_failed: false }],
      guardian_flags: [], amendments: [],
    }, { unique: uniqueCheckId })

    const res = await classifyAndRecord(fake.client as any, base())

    expect(res.status).toBe('classified')
    expect(fake.tables.guardian_flags).toHaveLength(1)
    expect((res as any).flagId).toBe(fake.tables.guardian_flags[0].id)
  })

  it('migration 123 adds a partial unique index on guardian_flags(check_id), skipped with a NOTICE if duplicates exist', () => {
    const sql = read('supabase/migrations/123_guardian_section13_pass2_fixes.sql')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS guardian_flags_check_id_unique\s+ON public\.guardian_flags \(check_id\) WHERE check_id IS NOT NULL/)
    expect(sql).toMatch(/HAVING count\(\*\) > 1/)
    expect(sql).toMatch(/RAISE NOTICE/)
  })

  it('the sweep does not treat a never-attempted row as due until the live request has had time to finish', () => {
    // pass 4 (B5): the grace + backoff rule moved from the route into lib/ai/guardian-pipeline.ts so the query and the JS backstop share it
    const pipe = read('lib/ai/guardian-pipeline.ts')
    const route = read('app/api/cron/guardian-health/route.ts')
    expect(pipe).toMatch(/GUARDIAN_LIVE_PATH_GRACE_MS = 10 \* 60000/)
    expect(pipe).toMatch(/if \(!r\.last_attempt_at\) return nowMs - new Date\(r\.created_at\)\.getTime\(\) >= GUARDIAN_LIVE_PATH_GRACE_MS/)
    expect(pipe).not.toMatch(/if \(!r\.last_attempt_at\) return true/)
    expect(route).toContain('isSweepDue(r, now)')
  })
})

describe('G3 — a broken sweep fails the run instead of recording a healthy heartbeat', () => {
  it('throws (=> alertCronFailure, no heartbeat) when the sweep returned { error }, before the heartbeat is written', () => {
    const src = read('app/api/cron/guardian-health/route.ts')
    const throwAt = src.indexOf("if ('error' in sweep) throw new Error(")
    const heartbeatAt = src.indexOf("recordCronHeartbeat(service, 'guardian-health'")
    expect(throwAt).toBeGreaterThan(-1)
    expect(throwAt).toBeLessThan(heartbeatAt)
    // the failed-check alerts still run first
    expect(src.indexOf('guardian_health:unresolved_failures')).toBeLessThan(throwAt)
    expect(src).toMatch(/alertCronFailure\(createServiceClient\(\), 'guardian-health', err\)/)
  })
})

describe('G4 — read failures are 500s, not "empty" or "not found"', () => {
  it('resolveEntity throws on a real error (only no-row / malformed id is null)', async () => {
    const { resolveEntity } = await import('@/lib/utils/flag-governance')
    const boom = createFakeSupabase({ guardian_flags: [] }, { errors: [{ table: 'guardian_flags', op: 'select', message: 'timeout', code: '57014' }] })
    await expect(resolveEntity(boom.client as any, 'w1', 'flag', 'f1')).rejects.toThrow(/resolveEntity\(flag\)/)

    const missing = createFakeSupabase({ guardian_flags: [] })
    expect(await resolveEntity(missing.client as any, 'w1', 'flag', 'f1')).toBeNull()

    const malformed = createFakeSupabase({ guardian_flags: [] }, { errors: [{ table: 'guardian_flags', op: 'select', message: 'invalid input syntax for type uuid', code: '22P02' }] })
    expect(await resolveEntity(malformed.client as any, 'w1', 'flag', 'garbage')).toBeNull()
  })

  const cases: Array<[string, string]> = [
    ['app/api/scope-governance/[entityType]/[entityId]/comments/route.ts', 'flag_comments read failed'],
    ['app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts', 'flag_attachments read failed'],
    ['app/api/scope-governance/[entityType]/[entityId]/attachments/[attachmentId]/route.ts', 'flag_attachments lookup failed'],
    ['app/api/guardian/checks/[id]/attachments/route.ts', 'guardian_checks lookup failed'],
    ['app/api/guardian/checks/route.ts', 'project lookup failed'],
    ['app/api/guardian/flags/[id]/route.ts', 'guardian_checks read failed'],
  ]
  for (const [file, needle] of cases) {
    it(`${file.replace('app/api/', '')} reads the error`, () => {
      expect(read(file)).toContain(needle)
    })
  }

  it('exceptions PATCH answers 500 (not 404) when the lookup errors', () => {
    expect(read('app/api/guardian/exceptions/[id]/route.ts'))
      .toMatch(/if \(excErr && excErr\.code !== '22P02'\) return NextResponse\.json\(\{ error: 'Could not load the exception' \}, \{ status: 500 \}\)/)
  })
})

describe('G5 — a finished project is read-only for flags that would go live again', () => {
  it('flag PATCH refuses exception / escalate / confirm_out_of_scope / reopen on Complete or Archived, but not resolve / close / dismiss_borderline', () => {
    const src = read('app/api/guardian/flags/[id]/route.ts')
    const m = src.match(/const TERMINAL_BLOCKED_FLAG_ACTIONS = new Set\(\[([^\]]*)\]\)/)
    expect(m).toBeTruthy()
    const blocked = (m![1].match(/'([a-z_]+)'/g) || []).map(s => s.replace(/'/g, '')).sort()
    expect(blocked).toEqual(['confirm_out_of_scope', 'escalate', 'exception', 'reopen'])
    // the guard sits before the action switch
    expect(src.indexOf('TERMINAL_BLOCKED_FLAG_ACTIONS.has(action)')).toBeLessThan(src.indexOf('switch (action)'))
    expect(src).toMatch(/isTerminalStatus\(flagProjectRow\?\.status \|\| ''\)/)
  })

  it('scope-adjustment refuses a Complete / Archived project before touching the snapshot', () => {
    const src = read('app/api/guardian/scope-adjustment/route.ts')
    expect(src).toMatch(/\.select\('id,name,status'\)/)
    expect(src.indexOf('isTerminalStatus(project.status)')).toBeGreaterThan(-1)
    expect(src.indexOf('isTerminalStatus(project.status)')).toBeLessThan(src.indexOf("from('project_scope_snapshot')"))
  })
})
