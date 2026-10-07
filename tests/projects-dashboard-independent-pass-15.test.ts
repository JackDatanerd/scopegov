// Projects & Dashboard independent pass 15.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMemberProjectIds } from '@/lib/utils/member-project-ids'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

function fakeService(rows: any[]) {
  const calls: any[][] = []
  const q: any = {}
  for (const m of ['select', 'eq', 'order']) q[m] = (...a: any[]) => { calls.push([m, ...a]); return q }
  q.range = (from: number, to: number) => { calls.push(['range', from, to]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }) }
  return { service: { from: (t: string) => { calls.push(['from', t]); return q } }, calls }
}

describe('B1 member project ids are scoped to the active workspace', () => {
  it('filters on the workspace and on an active membership', async () => {
    const { service, calls } = fakeService([{ id: 'a', project_id: 'p1' }])
    expect(await loadMemberProjectIds(service, 'ws-1', 'u1')).toEqual(['p1'])
    expect(calls).toContainEqual(['eq', 'workspace_members.workspace_id', 'ws-1'])
    expect(calls).toContainEqual(['eq', 'workspace_members.status', 'active'])
    expect(calls).toContainEqual(['eq', 'workspace_members.user_id', 'u1'])
  })
})

describe('B2 a long-idle poll cannot skip edits/deletes', () => {
  const route = src('app/api/projects/[id]/messages/route.ts')
  const ui = src('components/projects/ProjectDiscussion.tsx')
  it('the route over-fetches by one and reports truncation', () => {
    expect(route).toMatch(/limit\(CHANGED_LIMIT \+ 1\)/)
    expect(route).toMatch(/changedTruncated = \(changedRows \|\| \[\]\)\.length > CHANGED_LIMIT/)
    expect(route).toMatch(/NextResponse\.json\(\{ messages, changed, changedTruncated,/)
  })
  it('the feed reloads instead of advancing its cursor on truncation', () => {
    expect(ui).toMatch(/if \(json\.changedTruncated\) \{ await load\(\); return \}/)
  })
})

describe('B3 read marker compares at microsecond precision', () => {
  const route = src('app/api/projects/[id]/messages/read/route.ts')
  it('no longer skips on a millisecond tie', () => {
    expect(route).toMatch(/targetMicros <= existingMicros/)
    expect(route).not.toMatch(/target <= existingMs/)
  })
})

describe('B4 lapsed settlement gate on a changes-requested SOW withdraw', () => {
  it('ProjectDetail offers it to settleSow holders too', () => {
    expect(src('components/projects/ProjectDetail.tsx'))
      .toMatch(/s\.status === 'changes_requested' && \(permissions\.sendSow \|\| permissions\.settleSow\)/)
  })
})
