// lib/auth/session.ts

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import type { SessionUser, Permission } from '@/lib/supabase/types'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'

export async function getSession(): Promise<SessionUser | null> {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const service = createServiceClient()

    // FIX: active_workspace_id was fetched but never actually used — this
    // always picked the OLDEST workspace_members row regardless of which
    // workspace was set active. That's why an existing user who accepted an
    // invite to a second workspace (which correctly sets
    // users.active_workspace_id to the new workspace) never actually saw
    // it: this query kept surfacing their original, first-created
    // workspace every time. Look up active_workspace_id first, then prefer
    // that membership; fall back to the oldest active membership if it's
    // unset or stale (e.g. points to a workspace they're no longer in).
    const { data: userRow } = await (service as any)
      .from('users').select('active_workspace_id, deleted_at').eq('id', user.id).maybeSingle()

    // FIX (cron/portal audit round 2): a soft-deleted account is never a valid session. Nothing used to
    // check deleted_at anywhere, so a deleted user's still-valid JWT (or, before deletion started banning
    // the auth user, their password) kept working. Belt-and-braces with the ban in account/delete.
    if (userRow?.deleted_at) return null

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — defense
    // in depth): neither query below used to select workspaces.deleted_at
    // at all, so nothing here would notice if a membership row somehow
    // pointed at a soft-deleted workspace — normally impossible (delete
    // deactivates every member), but the invite-acceptance routes had a
    // gap (now fixed) that could reactivate exactly such a row. Belt-and-
    // braces: never resolve a session onto a deleted workspace, no matter
    // how a stray active-status row pointing at one came to exist.
    let memberRow: any = null
    if (userRow?.active_workspace_id) {
      const { data } = await (service as any)
        .from('workspace_members')
        .select(`
          id,
          effective_permissions,
          workspace_id,
          workspaces (
            id, name, agency_name, plan_tier, trial_ends_at, onboarding_completed_at,
            brand_colour, logo_storage_path, deleted_at
          ),
          users!workspace_members_user_id_fkey (
            id, name, email, avatar_url, email_verified_at, active_workspace_id
          )
        `)
        .eq('user_id', user.id)
        .eq('workspace_id', userRow.active_workspace_id)
        .eq('status', 'active')
        .maybeSingle()
      memberRow = data?.workspaces?.deleted_at ? null : data
    }

    if (!memberRow) {
      // Fetch a few candidates rather than just the single oldest one, so
      // a deleted workspace occupying that slot doesn't fully defeat the
      // fallback — pick the oldest active membership whose workspace is
      // actually still there.
      const { data } = await (service as any)
        .from('workspace_members')
        .select(`
          id,
          effective_permissions,
          workspace_id,
          workspaces (
            id, name, agency_name, plan_tier, trial_ends_at, onboarding_completed_at,
            brand_colour, logo_storage_path, deleted_at
          ),
          users!workspace_members_user_id_fkey (
            id, name, email, avatar_url, email_verified_at, active_workspace_id
          )
        `)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(5)
      memberRow = (data || []).find((m: any) => m.workspaces && !m.workspaces.deleted_at) || null
    }

    if (!memberRow) return null

    const ws    = memberRow.workspaces
    const u     = memberRow.users
    const perms = memberRow.effective_permissions as Record<string, boolean>

    return {
      id:                   user.id,
      name:                 u?.name || user.user_metadata?.name || user.email!,
      email:                u?.email || user.email!,
      avatarUrl:            u?.avatar_url || null,
      workspaceId:          memberRow.workspace_id,
      workspaceName:        ws?.name || '',
      agencyName:           ws?.agency_name || '',
      planTier:             ws?.plan_tier || 'trial',
      trialEndsAt:          ws?.trial_ends_at || null,
      onboardingCompletedAt: ws?.onboarding_completed_at || null,
      permissions:          Object.keys(perms).filter(k => perms[k]) as Permission[],
      // C2: fall back to Supabase auth email_confirmed_at so existing sessions
      // aren't blocked by a stale null in public.users
      emailVerifiedAt:      u?.email_verified_at || user.email_confirmed_at || null,
      logoStoragePath:      ws?.logo_storage_path || null,
      brandColour:          ws?.brand_colour || null,
      hasPasswordIdentity:  (user.identities || []).some((i: any) => i.provider === 'email'),
    }
  } catch {
    return null
  }
}

// FIX (deep audit, Auth+MFA section): middleware.ts's forced-enrollment
// gate correctly decides "does this user need MFA" by checking EVERY
// active workspace membership — a Member in Workspace A who is also an
// Admin in Workspace B must still enroll, even while A is active. But
// three other call sites (mfa-setup's "mandatory" badge, DELETE
// /api/auth/mfa/factors' own guard, and change-password's aal2 gate) all
// asked the narrower question "does the ACTIVE workspace require it,"
// using session.permissions or a single active_workspace_id lookup. That
// mismatch let a user with a mandatory role in a non-active workspace see
// mfa-setup's "Skip for now" link (looping them straight back once
// middleware re-checked), and let the same user successfully disable MFA
// through the factors endpoint that exists specifically to prevent that.
// This is the one aggregate check all four sites should share.
export async function userHasAnyMfaMandatoryMembership(userId: string): Promise<boolean> {
  const service = createServiceClient()
  const { data: memberships } = await (service as any)
    .from('workspace_members')
    .select('effective_permissions')
    .eq('user_id', userId)
    .eq('status', 'active')
  return (memberships || []).some((m: any) => permissionsRequireMfa(m.effective_permissions))
}

// FIX (deep audit, RLS+permissions section — audit-log workspace-fallback
// gap): mfa/verify/route.ts and login-event/route.ts each independently
// defined this exact "prefer active_workspace_id, fall back to the oldest
// active membership" lookup for attributing a per-workspace audit_log row
// to a user-level security action — but change-password, DELETE
// /api/auth/mfa/factors, mfa/backup-codes, and password-changed all used
// only the bare `userRow?.active_workspace_id || ''` half of that logic,
// with no fallback. audit_log.workspace_id is NOT NULL, so passing '' for
// a user whose active_workspace_id is unset (e.g. right after a workspace
// they were in got deleted and nothing reassigned it) makes the insert
// fail — silently, since logAudit swallows its own errors — dropping
// password-changed, MFA-disabled, backup-codes-regenerated, and MFA-
// recovery events from the audit trail specifically in the case where
// having a trustworthy trail matters most. Centralizing the one already-
// correct version here so every caller gets the fallback instead of
// reimplementing (or omitting) it.
// FIX (deep audit, Auth+MFA section, standalone pass): unlike its sibling
// lookups in getSession() above (which explicitly select and check
// workspaces.deleted_at, precisely because the invite-acceptance routes
// once had a gap that could reactivate a membership row pointing at a
// deleted workspace — see that fix's own comment), neither branch here
// checked deleted_at at all. This function only feeds audit-log
// attribution (login-event/route.ts, callback/route.ts), never
// authorization, so the impact is cosmetic — but a stray active-status
// row pointing at a deleted workspace could still resolve a login-event
// entry onto a workspace_id whose row no longer really exists for
// anything else the app does. Same belt-and-braces fix, same shape.
export async function resolveActiveWorkspaceId(service: any, userId: string): Promise<string | null> {
  const { data } = await service.from('users').select('active_workspace_id').eq('id', userId).maybeSingle()
  if (data?.active_workspace_id) {
    const { data: member } = await service.from('workspace_members')
      .select('workspace_id, workspaces(deleted_at)')
      .eq('user_id', userId).eq('workspace_id', data.active_workspace_id).eq('status', 'active')
      .maybeSingle()
    if (member?.workspace_id && !member.workspaces?.deleted_at) return member.workspace_id
  }
  const { data: candidates } = await service.from('workspace_members')
    .select('workspace_id, workspaces(deleted_at)').eq('user_id', userId).eq('status', 'active')
    .order('created_at', { ascending: true }).limit(5)
  const fallback = (candidates || []).find((m: any) => m.workspaces && !m.workspaces.deleted_at)
  return fallback?.workspace_id || null
}

// FIX (deep audit, Auth+MFA section — actor-name staleness): every route
// in this section (change-password, mfa/verify, mfa/factors DELETE,
// mfa/backup-codes, mfa/recover, password-changed, login-event, callback,
// signout-others) wrote actorName — and the "Hi {name}," greeting in the
// security email that goes with it — from `user.user_metadata?.name`,
// which is frozen at signup. api/workspace/profile/route.ts (the actual
// rename endpoint) only ever updates public.users.name; it never touches
// Supabase's own raw_user_meta_data. So the moment a user renames
// themselves via Settings, every single MFA/password security audit-log
// entry and notification email in this whole section carries the wrong
// name, forever. This is the exact staleness class already fixed
// everywhere else in the app (workspace/create, team/invite/accept,
// workspace/leave, workspace/complete-onboarding, and getSession() itself
// above all correctly prefer the canonical name) — just never touched in
// this section. Centralizing the fix here, same shape as
// resolveActiveWorkspaceId above, so every caller gets it instead of
// reimplementing (or continuing to omit) it.
export async function resolveActorName(service: any, userId: string, fallback: string): Promise<string> {
  const { data } = await service.from('users').select('name').eq('id', userId).maybeSingle()
  return data?.name || fallback
}

export function hasPermission(session: SessionUser, permission: Permission): boolean {
  return session.permissions.includes(permission)
}

export function requirePermission(session: SessionUser, permission: Permission): void {
  if (!hasPermission(session, permission)) {
    throw new Error(`Missing permission: ${permission}`)
  }
}

export function trialDaysLeft(session: SessionUser): number | null {
  if (session.planTier !== 'trial' || !session.trialEndsAt) return null
  const diff = new Date(session.trialEndsAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
}
