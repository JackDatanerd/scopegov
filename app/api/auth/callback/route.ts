// app/api/auth/callback/route.ts

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code  = searchParams.get('code')
  const next  = searchParams.get('next') ?? '/dashboard'
  const type  = searchParams.get('type')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?message=${encodeURIComponent(errorDescription || error)}`
    )
  }

  if (code) {
    const supabase = await createServerSupabaseClient()
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

    if (!exchangeError) {
      // Password reset — always redirect to reset-password page (C1)
      if (type === 'recovery') {
        return NextResponse.redirect(`${origin}/reset-password`)
      }

      const { data: { user } } = await supabase.auth.getUser()

      if (user) {
        // Mark email as verified now that we know confirmation happened (C1)
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

        if (!member) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }

        if (!member.workspace?.onboarding_completed_at) {
          return NextResponse.redirect(`${origin}/onboarding`)
        }
      }

      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?message=Link+expired+or+invalid.+Please+try+again.`)
}
