import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Regression coverage for the Onboarding fresh independent pass (round 8).
//   B1  create_workspace_atomic raised TRIAL_ALREADY_USED from users.trial_used_at alone (stamped at the
//       user's first-ever workspace creation), so discarding an abandoned >24h-old wizard workspace left
//       no way to ever create another one. Migration 133 adds users.trial_spent_at, set by a trigger when
//       a trial is genuinely consumed, and the cap now requires it.
//   B2  discardWorkspace() switched into otherWorkspaces[0] (a load-time snapshot) after the delete had
//       succeeded; a stale entry errored out and left the page on the deleted workspace.

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

describe('B1 trial cap counts spent trials only (migration 133)', () => {
  const sql = read('supabase/migrations/133_trial_cap_counts_spent_trials_only.sql')

  it('adds trial_spent_at and gates TRIAL_ALREADY_USED on it as well as trial_used_at', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS trial_spent_at timestamptz')
    expect(sql).toMatch(/existing_trial_used_at IS NOT NULL\s+AND existing_trial_spent_at IS NOT NULL\s+AND existing_trial_used_at < now\(\) - interval '24 hours'/)
    expect(sql).toContain("RAISE EXCEPTION 'TRIAL_ALREADY_USED'")
  })

  it('stamps trial_spent_at on onboarding completion, leaving the trial plan, and a still-trial hand-off', () => {
    expect(sql).toContain('OLD.onboarding_completed_at IS NULL AND NEW.onboarding_completed_at IS NOT NULL')
    expect(sql).toContain("OLD.plan_tier = 'trial' AND NEW.plan_tier <> 'trial'")
    expect(sql).toContain("OLD.created_by IS DISTINCT FROM NEW.created_by AND NEW.plan_tier = 'trial'")
    expect(sql).toContain('AFTER UPDATE OF onboarding_completed_at, plan_tier, created_by ON public.workspaces')
  })

  it('keeps the rest of create_workspace_atomic intact (owner role, membership, active workspace, trial_used_at)', () => {
    expect(sql).toContain('trial_used_at = COALESCE(trial_used_at, now())')
    expect(sql).toContain('active_workspace_id = p_workspace_id')
    expect(sql).toContain("RAISE EXCEPTION 'p_user_id must match the calling user'")
  })

  it('backfill keeps the cap for anyone with spent or purged history and frees only never-spent users', () => {
    expect(sql).toMatch(/onboarding_completed_at IS NOT NULL OR w\.plan_tier <> 'trial'/)
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.workspaces w WHERE w\.created_by = u\.id\)/)
  })
})

describe('B2 discard falls through when the remembered workspace is stale', () => {
  const src = read('app/onboarding/page.tsx')
  const start = src.indexOf('async function discardWorkspace()')
  const body = src.slice(start, src.indexOf('async function', start + 10))

  it('no longer routes the post-delete switch through switchToWorkspace (which only shows an error)', () => {
    expect(body).not.toContain('switchToWorkspace(otherWorkspaces[0].id)')
    expect(body).toContain('for (const w of otherWorkspaces)')
  })

  it('goes to the dashboard only when a switch actually succeeds, otherwise reaches onboarding-status', () => {
    const loop = body.indexOf('for (const w of otherWorkspaces)')
    const okIdx = body.indexOf("if (swRes.ok) { router.push('/dashboard'); return }")
    const statusIdx = body.indexOf("fetch('/api/workspace/onboarding-status')")
    expect(okIdx).toBeGreaterThan(loop)
    expect(statusIdx).toBeGreaterThan(okIdx)
  })
})
