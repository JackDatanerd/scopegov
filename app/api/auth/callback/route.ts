import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'
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
      // For new signups via Google OAuth, trigger workspace creation
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // Check if this user has a workspace_members row (i.e. has completed setup)
        const { data: member } = await (supabase as any)
          .from('workspace_members')
          .select('id, workspace:workspaces(onboarding_completed_at)')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .single()

        if (!member) {
          // Brand new OAuth user — send to onboarding
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
