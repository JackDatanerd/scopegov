import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isProjectBeyondLimit } from '@/lib/utils/project-limit'

const read = (p: string) => readFileSync(p, 'utf8')

// Minimal stand-in for the supabase query chain used by isProjectBeyondLimit.
function fakeService(rows: Array<{ id: string; created_at: string }>, error: { message: string } | null = null) {
  const chain: any = {
    select: () => chain, eq: () => chain, is: () => chain, in: () => chain, order: () => chain,
    limit: (n: number) => Promise.resolve({
      data: error ? null : [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(0, n),
      error,
    }),
  }
  return { from: () => chain }
}

describe('isProjectBeyondLimit — exactly one of two racing creates loses (B4)', () => {
  const rows = [
    { id: 'a', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', created_at: '2026-02-01T00:00:00Z' },
    { id: 'c', created_at: '2026-02-01T00:00:01Z' }, // the two racers for the last slot of a 2-project plan: b and c
  ]
  it('solo (limit 2): the earlier racer keeps its slot, the later one is beyond the limit', async () => {
    expect(await isProjectBeyondLimit(fakeService(rows), 'ws', 'solo', 'b')).toBe(false)
    expect(await isProjectBeyondLimit(fakeService(rows), 'ws', 'solo', 'c')).toBe(true)
  })
  it('a project inside the limit is never beyond it', async () => {
    expect(await isProjectBeyondLimit(fakeService(rows), 'ws', 'solo', 'a')).toBe(false)
  })
  it('unlimited plans never roll back', async () => {
    expect(await isProjectBeyondLimit(fakeService(rows), 'ws', 'pro', 'c')).toBe(false)
  })
  it('a read error throws instead of silently keeping the project', async () => {
    await expect(isProjectBeyondLimit(fakeService(rows, { message: 'boom' }), 'ws', 'solo', 'c')).rejects.toThrow(/plan limit check failed/)
  })
})

describe('project create defers archived-client reactivation until the project is kept (B4)', () => {
  const src = read('app/api/projects/route.ts')
  it('records the client instead of updating it at lookup time', () => {
    expect(src).toMatch(/clientToReactivate = \{ id: /)
    const beforeInsert = src.slice(0, src.indexOf(".from('projects')\n      .insert("))
    expect(beforeInsert).not.toMatch(/update\(\{ status: 'active' \}\)/)
  })
  it('reactivates after the limit check and creator-membership insert', () => {
    expect(src.indexOf('isProjectBeyondLimit(service')).toBeLessThan(src.indexOf('if (clientToReactivate)'))
    expect(src.indexOf("from('project_members').insert")).toBeLessThan(src.indexOf('if (clientToReactivate)'))
  })
})

describe('PATCH /api/projects/[id] structural lock only fires on a real change (B2)', () => {
  const src = read('app/api/projects/[id]/route.ts')
  it('compares each structural field with the stored value', () => {
    expect(src).toMatch(/body\.clientId !== undefined && body\.clientId !== project\.client_id/)
    expect(src).toMatch(/body\.type !== undefined && body\.type !== project\.type/)
    expect(src).toMatch(/toUpperCase\(\) === project\.currency/)
  })
  it('no longer locks on mere presence', () => {
    expect(src).not.toMatch(/const structuralEdit = body\.clientId !== undefined \|\| body\.type !== undefined/)
  })
})

describe('dashboard expired-trial banner is reachable (B1)', () => {
  const dash = read('app/(app)/dashboard/page.tsx')
  const session = read('lib/auth/session.ts')
  it('has a trialExpired helper keyed on solo + a past trial_ends_at', () => {
    expect(session).toMatch(/export function trialExpired/)
    expect(session).toMatch(/planTier !== 'solo' \|\| !session\.trialEndsAt/)
  })
  it('both the dashboard and its empty state render the shared banner', () => {
    expect(dash.match(/<TrialBanner /g)?.length).toBe(2)
    // A lapsed workspace is announced by the app-wide read-only banner in (app)/layout.tsx; the dashboard adds none.
    expect(dash).toMatch(/if \(session\.lapsed\) return null/)
    expect(read('app/(app)/layout.tsx')).toMatch(/session\.lapsed &&/)
  })
})

describe('new-project wizard cannot pick an archived client once the project exists (B3)', () => {
  const src = read('app/(app)/projects/new/page.tsx')
  it("disables archived clients when projectId is set", () => {
    expect(src).toMatch(/disabled=\{c\.status === 'archived' && !!projectId\}/)
  })
})

describe('project page title respects project access (B5)', () => {
  const src = read('app/(app)/projects/[id]/page.tsx')
  it('generateMetadata checks canReadProject before reading the name', () => {
    const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default async function ProjectPage'))
    expect(meta).toMatch(/canReadProject\(service, session, id\)/)
    expect(meta.indexOf('canReadProject')).toBeLessThan(meta.indexOf(".select('name')"))
  })
})

describe('regression guard: fixes that a stale-base tarball once reverted (B6)', () => {
  const page = read('app/(app)/projects/[id]/page.tsx')
  const detail = read('components/projects/ProjectDetail.tsx')
  it('Billing tab position is computed live, not read from the ascending 90-row snapshot history', () => {
    expect(page).toMatch(/computeContractPosition\(service, id\)/)
    expect(page).not.toMatch(/contract_reconciliation_snapshots/)
  })
  it('an open-ended retainer is described as billed monthly, not "not set"', () => {
    expect(detail).toMatch(/Open-ended — billed monthly until the project is completed or archived/)
    expect(detail).not.toMatch(/monthly billing won\\u2019t auto-generate/)
  })
})
