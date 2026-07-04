// app/api/auth/callback/route.ts

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
  let exchangeError: any = null

  if (code) {
    // PKCE flow — standard signup / OAuth / magic link
    const result = await supabase.auth.exchangeCodeForSession(code)
    exchangeError = result.error
    if (!exchangeError && type === 'recovery') {
      return NextResponse.redirect(`${origin}/reset-password`)
    }
  } else if (tokenHash && type) {
    // token_hash flow — used by Supabase password-reset emails by default.
    // exchangeCodeForSession does NOT work here; verifyOtp must be used instead.
    const result = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    exchangeError = result.error
    if (!exchangeError && type === 'recovery') {
      return NextResponse.redirect(`${origin}/reset-password`)
    }
  } else {
    return NextResponse.redirect(
      `${origin}/login?message=Link+expired+or+invalid.+Please+try+again.`
    )
  }

  if (!exchangeError) {
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

  return NextResponse.redirect(
    `${origin}/login?message=Link+expired+or+invalid.+Please+try+again.`
  )
}
