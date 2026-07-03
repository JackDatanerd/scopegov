// lib/auth/session.ts

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import type { SessionUser, Permission } from '@/lib/supabase/types'

export async function getSession(): Promise<SessionUser | null> {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const service = createServiceClient()

    const { data: memberRow } = await (service as any)
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
