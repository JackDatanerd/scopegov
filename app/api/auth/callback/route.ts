import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code        = searchParams.get('code')
  const tokenHash   = searchParams.get('token_hash')
  const type        = searchParams.get('type')
  const next        = searchParams.get('next') ?? '/dashboard'
  const error       = searchParams.get('error')
  const errorDesc   = searchParams.get('error_description')

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?message=${encodeURIComponent(errorDesc || error)}`
    )
  }

  const supabase = await createServerSupabaseClient()

  // ── Email OTP flow (password reset, magic link, email confirm) ─────────
  // Supabase sends token_hash + type for these — NOT a code.
  if (tokenHash && type) {
    const otpType = type as any

    if (type === 'recovery') {
      // Password reset — verify token then go to reset-password page
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'recovery',
      })
      if (verifyErr) {
        return NextResponse.redirect(
          `${origin}/login?message=${encodeURIComponent('Reset link expired or already used. Request a new one.')}`
        )
      }
      // Session is now set — user lands on reset-password with a valid session
      return NextResponse.redirect(`${origin}/reset-password`)
    }

    // email_change, signup confirm etc.
    const { error: verifyErr } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    })
    if (!verifyErr) {
      // Mark email as verified in our own users table
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const service = createServiceClient()
        await (service as any).from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id)
          .is('email_verified_at', null)
      }
      return NextResponse.redirect(`${origin}${next}`)
    }
    return NextResponse.redirect(
      `${origin}/login?message=${encodeURIComponent('Link expired or invalid. Please try again.')}`
    )
  }

  // ── OAuth / PKCE code flow ─────────────────────────────────────────────
  if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (!exchangeError) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // Mark email verified in users table (OAuth emails are pre-verified)
        const service = createServiceClient()
        await (service as any).from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id)
          .is('email_verified_at', null)

        // Route based on workspace/onboarding status
        const { data: member } = await (supabase as any)
          .from('workspace_members')
          .select('id, workspace:workspaces(onboarding_completed_at, deleted_at)')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .single()

        if (!member || member.workspace?.deleted_at) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }
        if (!member.workspace?.onboarding_completed_at) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }
      }
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(
    `${origin}/login?message=${encodeURIComponent('Link expired or invalid. Please try again.')}`
  )
}
