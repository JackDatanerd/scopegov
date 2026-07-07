// app/api/auth/callback/route.ts
// FIX 1: Password reset now works via redirectTo → callback?next=/reset-password
// After exchangeCodeForSession, if next=/reset-password, return early with valid session.
// token_hash path kept for email confirmation links.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const tokenHash  = searchParams.get('token_hash')
  const type       = searchParams.get('type') as EmailOtpType | null
  const next       = searchParams.get('next') ?? '/dashboard'
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
      // FIX 1: Password reset flow — forgot-password page sends
      // redirectTo: origin + '/api/auth/callback?next=/reset-password'
      // Session is now established; send straight to the reset form.
      if (next === '/reset-password') {
        return NextResponse.redirect(`${origin}/reset-password`)
      }

      const { data: { user } } = await supabase.auth.getUser()

      if (user) {
        const serviceClient = createServiceClient()
        await (serviceClient as any)
          .from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id)
          .is('email_verified_at', null)

        const { data: member } = await (supabase as any)
          .from('workspace_members')
          .select('id, workspace:workspaces(onboarding_completed_at)')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .single()

        if (!member) return NextResponse.redirect(`${origin}/onboarding`)
        if (!member.workspace?.onboarding_completed_at) {
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

        const { data: member } = await (supabase as any)
          .from('workspace_members')
          .select('id, workspace:workspaces(onboarding_completed_at)')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .single()

        if (!member) return NextResponse.redirect(`${origin}/onboarding`)
        if (!member.workspace?.onboarding_completed_at) {
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
