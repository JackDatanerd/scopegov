// tests/projects-dashboard-pass-6.test.ts
//
// Projects & Dashboard (section 7) independent pass 6:
//   B1  project page selects project_scope_snapshot.last_updated_by (the Overview provenance label reads it)
//   B2  Discussion composer does not append a message the poll already delivered
//   B3  an unknown ?tab= opens Overview instead of leaving no tab active
//   H1  the restricted-member project-id read is paged (PostgREST silently caps a plain select at 1000 rows)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMemberProjectIds } from '@/lib/utils/member-project-ids'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('B1 scope snapshot provenance', () => {
  const page = src('app/(app)/projects/[id]/page.tsx')
  const detail = src('components/projects/ProjectDetail.tsx')
  it('the project page selects last_updated_by', () => {
    expect(page).toMatch(/project_scope_snapshot\(id, deliverables, out_of_scope, last_updated_at, last_updated_by\)/)
  })
  it('the component still branches on it (so the select is what was missing)', () => {
    expect(detail).toMatch(/snapshot\?\.last_updated_by === 'amendment'/)
    expect(detail).toMatch(/snapshot\?\.last_updated_by === 'scope_adjustment'/)
  })
  it('no // comment sits inside the select template literal (it would 404 every project)', () => {
    const start = page.indexOf(".select(`")
    const end = page.indexOf('`)', start)
    expect(page.slice(start, end)).not.toMatch(/\/\//)
  })
})

describe('B2 discussion composer de-duplicates its own appended message', () => {
  const s = src('components/projects/ProjectDiscussion.tsx')
  const submit = s.slice(s.indexOf('async function submit()'), s.indexOf('function startEdit'))
  it('skips the append when the id is already present', () => {
    expect(submit).toMatch(/setMessages\(prev => prev\.some\(m => m\.id === json\.message\.id\) \? prev : \[\.\.\.prev, json\.message\]\)/)
  })
  it('still clears the draft only after the message list is updated (pass-5 B1 guard)', () => {
    expect(submit.indexOf("setDraft('')")).toBeGreaterThan(submit.indexOf('setMessages(prev'))
  })
})

describe('B3 unknown ?tab= falls back to Overview', () => {
  const s = src('components/projects/ProjectDetail.tsx')
  it('validates the seed against TABS', () => {
    expect(s).toMatch(/useState\(TABS\.some\(t => t\.key === initialTab\) \? initialTab : 'overview'\)/)
  })
  it('does not seed from the raw value any more', () => {
    expect(s).not.toMatch(/useState\(initialTab\)/)
  })
})

// A PostgREST stand-in: select().eq().order().range(from, to), hard-capped at 1000 rows per response.
function fakeService(rows: Array<{ id: string; project_id: string }>, opts: { error?: string } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const builder: any = {
    select: (...a: unknown[]) => { calls.push(['select', ...a]); return builder },
    eq: (...a: unknown[]) => { calls.push(['eq', ...a]); return builder },
    order: (...a: unknown[]) => { calls.push(['order', ...a]); return builder },
    range: (from: number, to: number) => {
      calls.push(['range', from, to])
      if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } })
      const slice = rows.slice(from, Math.min(to, from + 999) + 1)
      return Promise.resolve({ data: slice, error: null })
    },
  }
  return { service: { from: (t: string) => { calls.push(['from', t]); return builder } }, calls }
}
const mkRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(5, '0')}`, project_id: `p${i}` }))

describe('H1 loadMemberProjectIds', () => {
  it('returns every id past the 1000-row cap', async () => {
    const { service } = fakeService(mkRows(2500))
    const ids = await loadMemberProjectIds(service, 'w1', 'u1')
    expect(ids.length).toBe(2500)
    expect(ids[0]).toBe('p0')
    expect(ids[2499]).toBe('p2499')
  })
  it('handles exactly one full page and an empty result', async () => {
    expect((await loadMemberProjectIds(fakeService(mkRows(1000)).service, 'w1', 'u1')).length).toBe(1000)
    expect((await loadMemberProjectIds(fakeService([]).service, 'w1', 'u1')).length).toBe(0)
  })
  it('de-duplicates a project reached through more than one membership row', async () => {
    const rows = [{ id: 'a', project_id: 'p1' }, { id: 'b', project_id: 'p1' }, { id: 'c', project_id: 'p2' }]
    expect(await loadMemberProjectIds(fakeService(rows).service, 'w1', 'u1')).toEqual(['p1', 'p2'])
  })
  it('filters on the member, orders deterministically and pages with range', async () => {
    const { service, calls } = fakeService(mkRows(1))
    await loadMemberProjectIds(service, 'w1', 'user-9')
    expect(calls).toContainEqual(['from', 'project_members'])
    expect(calls).toContainEqual(['eq', 'workspace_members.user_id', 'user-9'])
    expect(calls).toContainEqual(['order', 'id'])
    expect(calls).toContainEqual(['range', 0, 999])
  })
  it('throws on a read error instead of reporting "no projects"', async () => {
    let msg = ''
    try { await loadMemberProjectIds(fakeService([], { error: 'boom' }).service, 'w1', 'u1') } catch (e: any) { msg = e.message }
    expect(msg).toMatch(/member project ids: boom/)
  })
})

describe('H1 every restricted-member reader uses the paged helper', () => {
  const files = [
    'app/api/projects/route.ts',
    'app/(app)/dashboard/page.tsx',
    'app/(app)/projects/page.tsx',
    'app/(app)/clients/page.tsx',
    'app/(app)/clients/[id]/page.tsx',
  ]
  for (const f of files) {
    it(`${f} calls loadMemberProjectIds and has no raw project_members id select`, () => {
      const s = src(f)
      expect(s).toMatch(/loadMemberProjectIds\(service, session\.workspaceId, session\.id\)/)
      expect(s).not.toMatch(/\.from\('project_members'\)\s*\n?\s*\.select\('project_id, workspace_members!inner\(user_id\)'\)/)
    })
  }
})
