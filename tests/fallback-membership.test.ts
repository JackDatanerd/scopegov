import { describe, it, expect } from 'vitest'
import { pickFallbackMembership } from '@/lib/auth/session'

// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
// finding): getSession(), resolveActiveWorkspaceId(), workspace/delete's
// reassignment loop, and leave_workspace_atomic (migration 065) all used
// to pick a fallback active workspace by oldest created_at alone, with no
// regard for whether that workspace had actually finished onboarding —
// see pickFallbackMembership's own comment in lib/auth/session.ts. These
// lock in the fixed behavior for the three JS call sites that share it
// (leave_workspace_atomic's own SQL-side fix is covered by migration
// 065's own logic, not unit-testable here).
function m(workspaceId: string, opts: { deleted?: boolean; done?: boolean } = {}) {
  return {
    workspace_id: workspaceId,
    workspaces: { deleted_at: opts.deleted ? '2026-01-01T00:00:00Z' : null, onboarding_completed_at: opts.done ? '2026-01-01T00:00:00Z' : null },
  }
}

describe('pickFallbackMembership', () => {
  it('returns null for an empty or all-deleted candidate list', () => {
    expect(pickFallbackMembership([])).toBeNull()
    expect(pickFallbackMembership(null)).toBeNull()
    expect(pickFallbackMembership([m('a', { deleted: true })])).toBeNull()
  })

  it('prefers an onboarding-complete workspace even when it is not the oldest', () => {
    // 'incomplete-older' would win under a pure oldest-created-first pick
    // (the exact bug this fix closes) — 'complete-newer' must win instead.
    const candidates = [m('incomplete-older', { done: false }), m('complete-newer', { done: true })]
    expect(pickFallbackMembership(candidates)?.workspace_id).toBe('complete-newer')
  })

  it('falls back to oldest-first among ties when nothing is complete', () => {
    const candidates = [m('oldest', {}), m('newer', {})]
    expect(pickFallbackMembership(candidates)?.workspace_id).toBe('oldest')
  })

  it('falls back to oldest-first among ties when everything is complete', () => {
    const candidates = [m('oldest', { done: true }), m('newer', { done: true })]
    expect(pickFallbackMembership(candidates)?.workspace_id).toBe('oldest')
  })

  it('skips a soft-deleted workspace even if it would otherwise win on completeness', () => {
    const candidates = [m('deleted-but-complete', { done: true, deleted: true }), m('incomplete-alive', { done: false })]
    expect(pickFallbackMembership(candidates)?.workspace_id).toBe('incomplete-alive')
  })
})
