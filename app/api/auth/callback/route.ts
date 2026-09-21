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
import { logLoginOnce } from '@/lib/auth/login-audit'
import { decodeJwtPayload, authenticationAgeSeconds, loginMethodFromAmr } from '@/lib/auth/auth-time'
import { resolveActorName } from '@/lib/auth/session'
import { TERMS_VERSION_PATTERN } from '@/lib/auth/terms'

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
  method: string,
  sinceSeconds: number
) {
  // FIX (deep audit, Auth+MFA section — actor-name staleness): see
  // resolveActorName's own comment in lib/auth/session.ts.
  const actorName = await resolveActorName(serviceClient, user.id, user.user_metadata?.name || user.email || '')
  // Fallback only: the auth.sessions trigger (migration 068) records sign-ins
  // server-side, and logLoginOnce stands down when it already did.
  await logLoginOnce(serviceClient as any, {
    workspaceId, userId: user.id, email: user.email || '', name: actorName, method, sinceSeconds,
  })
}

// Types this route will complete. FIX (build — Auth independent audit, LOW):
// `type` was passed to verifyOtp() unvalidated, so a link could complete a
// 'recovery' or 'invite' OTP here and be logged as an email confirmation. Password
// recovery is resolved on /reset-password (never here), and invites go through
// /invite/[token].
const CALLBACK_OTP_TYPES: EmailOtpType[] = ['signup', 'email', 'magiclink', 'email_change']

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const tokenHash  = searchParams.get('token_hash')
  const rawType    = searchParams.get('type')
  const type       = (CALLBACK_OTP_TYPES as string[]).includes(rawType || '') ? (rawType as EmailOtpType) : null
  // 'next' is attacker-controllable (it originates from the public /login page's
  // query string) — see lib/utils/safe-redirect.ts.
  const next       = safeRedirectPath(searchParams.get('next'))
  // An invite path is the one destination that is legitimate without a
  // membership: a pending invite has user_id NULL until accepted, so a
  // brand-new invitee must not be diverted into workspace-creation onboarding.
  const isInviteDestination = next.startsWith('/invite/')
  const error      = searchParams.get('error')
  // The terms version the person saw on the Google sign-up button (see
  // /signup). Stored server-side with a server timestamp.
  const termsParam = searchParams.get('terms')
  const termsVersion = termsParam && TERMS_VERSION_PATTERN.test(termsParam) ? termsParam : null

  // FIX (build — Auth independent audit, LOW): Supabase's `error_description`
  // used to be reflected into the login page's success box, so anyone could craft
  // a link that displayed arbitrary text on the real domain. Only a fixed code
  // is passed on now (see lib/auth/login-messages.ts).
  if (error) {
    return NextResponse.redirect(`${origin}/login?m=oauth_failed`)
  }

  const supabase = await createServerSupabaseClient()

  // Shared by the two success branches: mark the address verified, record terms
  // acceptance, refuse deleted accounts, and log the sign-in — unless a second
  // factor is still owed, in which case /api/auth/mfa/verify logs it once the
  // challenge passes (logging here would record "login succeeded" for attempts
  // that then fail MFA).
  async function finishSignIn(): Promise<NextResponse> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.redirect(`${origin}${next}`)

    const serviceClient = createServiceClient()

    const { data: userRow } = await (serviceClient as any)
      .from('users').select('deleted_at').eq('id', user.id).maybeSingle()
    if (userRow?.deleted_at) {
      await supabase.auth.signOut()
      return NextResponse.redirect(`${origin}/login?m=account_deleted`)
    }

    await (serviceClient as any)
      .from('users')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('id', user.id)
      .is('email_verified_at', null)

    if (termsVersion) {
      await (serviceClient as any)
        .from('users')
        .update({ terms_accepted_at: new Date().toISOString(), terms_version: termsVersion })
        .eq('id', user.id)
        .is('terms_accepted_at', null)
    }

    const member = await resolveOnboardingMember(serviceClient, user.id)
    if (!member) {
      return NextResponse.redirect(`${origin}${isInviteDestination ? next : '/onboarding'}`)
    }

    const mfaPending = ((user as any).factors as Array<{ status: string }> | undefined || [])
      .some(f => f.status === 'verified')
    if (!mfaPending) {
      // FIX (audit round 2): the method used to be a hard-coded hint — every `code`
      // exchange was logged as 'google', including PKCE email confirmations. Derive
      // it from the session's own amr instead.
      const { data: { session } } = await supabase.auth.getSession()
      const payload = decodeJwtPayload(session?.access_token)
      const age = authenticationAgeSeconds(payload)
      await logLoginEvent(serviceClient, user, member.workspaceId, loginMethodFromAmr(payload), (age ?? 60) + 5)
    }

    if (!member.onboardingCompletedAt && !isInviteDestination) {
      return NextResponse.redirect(`${origin}/onboarding`)
    }
    return NextResponse.redirect(`${origin}${next}`)
  }

  if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (!exchangeError) return finishSignIn()
  } else if (tokenHash && type) {
    const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!verifyError) return finishSignIn()
  }

  return NextResponse.redirect(`${origin}/login?m=link_invalid`)
}
