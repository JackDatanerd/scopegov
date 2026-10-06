import { describe, it, expect } from 'vitest'
import { reclassifyCheck, GUARDIAN_SYSTEM_ACTOR } from '../lib/ai/guardian-pipeline'

// Minimal chainable fake: every select/eq chain resolves to the canned row for that table.
function fakeService(workspace: Record<string, unknown>) {
  const calls: string[] = []
  const rows: Record<string, any> = {
    guardian_checks: { id: 'c1', project_id: 'p1', workspace_id: 'w1', content: 'add a blog', is_duplicate: false, outcome: 'pending',
      classification_failed: false, classification_attempts: 0, source: 'email', source_metadata: {}, embedding: null },
    projects: { id: 'p1', name: 'P', status: 'Active', stall_reason: null, deleted_at: null, workspace_id: 'w1',
      workspaces: { id: 'w1', guardian_sensitivity_tier: 'medium', deleted_at: null, ...workspace },
      project_scope_snapshot: { deliverables: [], out_of_scope: [], last_updated_at: null } },
  }
  return {
    calls,
    from(t: string) {
      const q: any = {
        select() { return q }, eq() { return q }, update() { calls.push(`update:${t}`); return q },
        maybeSingle: async () => ({ data: rows[t], error: null }),
        then: (r: any) => r({ data: [], error: null }),
      }
      return q
    },
  }
}

describe('reclassifyCheck on a lapsed workspace', () => {
  const opts = { actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.swept', emailPath: 'automatic re-check', requireFailed: false }
  it('skips with no claim and no usage when lapsed_at is set', async () => {
    const svc = fakeService({ plan_tier: 'solo', trial_ends_at: null, lapsed_at: '2026-10-01T00:00:00Z' })
    let used = false
    const res = await reclassifyCheck(svc, 'c1', { ...opts, recordUsage: async () => { used = true } })
    expect(res).toEqual({ status: 'skipped', reason: 'inactive' })
    expect(used).toBe(false)
    expect(svc.calls).toEqual([])
  })
  it('skips an expired trial that the cron has not marked yet', async () => {
    const svc = fakeService({ plan_tier: 'trial', trial_ends_at: '2020-01-01T00:00:00Z', lapsed_at: null })
    expect(await reclassifyCheck(svc, 'c1', opts)).toEqual({ status: 'skipped', reason: 'inactive' })
  })
  it('does not skip a paid workspace at the lapse gate', async () => {
    const svc = fakeService({ plan_tier: 'pro', trial_ends_at: null, lapsed_at: null })
    const res: any = await reclassifyCheck(svc, 'c1', opts).catch(() => ({ status: 'threw' }))
    expect(res.reason).not.toBe('inactive')
  })
})
