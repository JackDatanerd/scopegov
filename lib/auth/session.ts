// lib/auth/session.ts

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import type { SessionUser, Permission } from '@/lib/supabase/types'

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
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()

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
            brand_colour, logo_storage_path
          ),
          users!workspace_members_user_id_fkey (
            id, name, email, avatar_url, email_verified_at, active_workspace_id
          )
        `)
        .eq('user_id', user.id)
        .eq('workspace_id', userRow.active_workspace_id)
        .eq('status', 'active')
        .maybeSingle()
      memberRow = data
    }

    if (!memberRow) {
      const { data } = await (service as any)
        .from('workspace_members')
        .select(`
          id,
          effective_permissions,
          workspace_id,
          workspaces (
            id, name, agency_name, plan_tier, trial_ends_at, onboarding_completed_at,
            brand_colour, logo_storage_path
          ),
          users!workspace_members_user_id_fkey (
            id, name, email, avatar_url, email_verified_at, active_workspace_id
          )
        `)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .single()
      memberRow = data
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
    }
  } catch {
    return null
  }
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
