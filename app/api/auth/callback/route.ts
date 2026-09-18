// app/api/auth/callback/route.ts
// token_hash path handles email confirmation links; `code` handles OAuth
// (PKCE). Password reset does NOT come through here — see
// forgot-password/page.tsx / reset-password/page.tsx, which resolve the
// recovery link client-side via detectSessionInUrl directly on
// /reset-password.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { safeRedirectPath } from '@/lib/utils/safe-redirect'
import { logAudit } from '@/lib/utils/audit'
import { resolveActorName } from '@/lib/auth/session'

// FIX (deep audit, Auth+MFA independent re-pass — CRITICAL): this used to
// resolve "the" member row via a bare
// `.eq('user_id', user.id).eq('status','active').limit(1).single()` query
// with no ORDER BY and no preference for users.active_workspace_id — the
// exact "which workspace" resolution that getSession() (this same file's
// neighbour) and resolveActiveWorkspaceId() were both built to get right,
// with a fallback and a deleted-workspace guard, after that class of bug
// bit audit-log attribution elsewhere. This route never adopted either.
// For a returning multi-workspace OAuth user, an unordered query can pick
// a DIFFERENT workspace than their actual active one — misattributing the
// login audit row, sending them to /onboarding when their real active
// workspace is already onboarded (or the reverse), and in principle
// resolving onto a soft-deleted workspace (workspaces.deleted_at was never
// even selected here). Mirrors getSession()'s own active_workspace_id-
// first-then-fallback-then-deleted_at-filtered shape, scoped down to just
// what this route needs.
async function resolveOnboardingMember(
  service: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<{ workspaceId: string; onboardingCompletedAt: string | null } | null> {
  const { data: userRow } = await (service as any)
    .from('users').select('active_workspace_id').eq('id', userId).maybeSingle()

  if (userRow?.active_workspace_id) {
    const { data } = await (service as any)
      .from('workspace_members')
      .select('workspace_id, workspaces(onboarding_completed_at, deleted_at)')
      .eq('user_id', userId)
      .eq('workspace_id', userRow.active_workspace_id)
      .eq('status', 'active')
      .maybeSingle()
    if (data && !data.workspaces?.deleted_at) {
      return { workspaceId: data.workspace_id, onboardingCompletedAt: data.workspaces?.onboarding_completed_at || null }
    }
  }

  // Fall back to the oldest active membership whose workspace isn't
  // soft-deleted, same as getSession()'s own fallback.
  const { data: candidates } = await (service as any)
    .from('workspace_members')
    .select('workspace_id, workspaces(onboarding_completed_at, deleted_at)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(5)

  const fallback = (candidates || []).find((m: any) => !m.workspaces?.deleted_at)
  return fallback ? { workspaceId: fallback.workspace_id, onboardingCompletedAt: fallback.workspaces?.onboarding_completed_at || null } : null
}

// FIX (deep audit, Auth+MFA re-pass — login audit trail): see
// api/auth/login-event/route.ts for the full writeup. This route is
// already server-side and already has `user` in hand for both the OAuth
// (code) and email-confirmation (token_hash) flows, so it logs directly
// rather than making a second round trip. Only called once a member row
// (and therefore a workspace to attribute the entry to) exists — a
// brand-new signup with no workspace yet has nowhere for a per-workspace
// audit_log row to point.
async function logLoginEvent(
  serviceClient: ReturnType<typeof createServiceClient>,
  user: { id: string; email?: string | null; user_metadata?: any },
  workspaceId: string,
  method: 'google' | 'email_confirmation'
) {
  // FIX (deep audit, Auth+MFA section — actor-name staleness): see
  // resolveActorName's own comment in lib/auth/session.ts.
  const actorName = await resolveActorName(serviceClient, user.id, user.user_metadata?.name || user.email || '')
  await logAudit(serviceClient as any, {
    workspaceId, actorId: user.id,
    actorEmail: user.email || '', actorName,
    eventType: 'security.login_succeeded', entityType: 'user', entityId: user.id, entityName: user.email || '',
    metadata: { method },
  })
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const tokenHash  = searchParams.get('token_hash')
  const type       = searchParams.get('type') as EmailOtpType | null
  // FIX (audit round 3, item #7): 'next' is attacker-controllable (it
  // originates from the public /login page's own query string) and was
  // concatenated directly into a Location header — see
  // lib/utils/safe-redirect.ts for the exact open-redirect payload this
  // allowed and why the origin+next concatenation didn't actually
  // protect against it.
  const next       = safeRedirectPath(searchParams.get('next'))
  const error      = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?message=${encodeURIComponent(errorDescription || error)}`
    )
  }

  const supabase = await createServerSupabaseClient()

  if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

    if (!exchangeError) {
      const { data: { user } } = await supabase.auth.getUser()

      if (user) {
        const serviceClient = createServiceClient()
        await (serviceClient as any)
          .from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id)
          .is('email_verified_at', null)

        const member = await resolveOnboardingMember(serviceClient, user.id)

        if (!member) return NextResponse.redirect(`${origin}/onboarding`)
        await logLoginEvent(serviceClient, user, member.workspaceId, 'google')
        if (!member.onboardingCompletedAt) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }
      }

      return NextResponse.redirect(`${origin}${next}`)
    }
  } else if (tokenHash && type) {
    // token_hash flow — used by email confirmation links
    const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })

    if (!verifyError) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const serviceClient = createServiceClient()
        await (serviceClient as any)
          .from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id)
          .is('email_verified_at', null)

        const member = await resolveOnboardingMember(serviceClient, user.id)

        if (!member) return NextResponse.redirect(`${origin}/onboarding`)
        await logLoginEvent(serviceClient, user, member.workspaceId, 'email_confirmation')
        if (!member.onboardingCompletedAt) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }
      }
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(
    `${origin}/login?message=Link+expired+or+invalid.+Please+try+again.`
  )
}
