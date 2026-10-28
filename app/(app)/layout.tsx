import { redirect } from 'next/navigation'
import { getSessionStrict } from '@/lib/auth/session'
import Sidebar from '@/components/layout/Sidebar'
import AppShell, { SidebarReopenBar } from '@/components/layout/AppShell'
import CommandPalette from '@/components/layout/CommandPalette'
import StepUpHost from '@/components/auth/StepUpHost'
import MfaRecommendBanner from '@/components/auth/MfaRecommendBanner'
import LapsedBanner from '@/components/layout/LapsedBanner'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { mfaIsEnforced, permissionsRequireMfa } from '@/lib/auth/mfa-policy'
import { hasFeature } from '@/lib/billing/entitlements'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionStrict()
  if (!session) redirect('/login')
  if (!session.onboardingCompletedAt) redirect('/onboarding')

  // 2FA is recommended (not forced) for sensitive roles: nudge anyone without a second factor.
  let showMfaNudge = false
  if (!mfaIsEnforced() && permissionsRequireMfa(session.permissions as any)) {
    try {
      const supabase = await createServerSupabaseClient()
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      showMfaNudge = !!aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal1'
    } catch { /* a courtesy nudge never breaks the page */ }
  }

  return (
    <AppShell>
      <Sidebar session={session} />
      <main className="app-main">
        <SidebarReopenBar />
        {session.lapsed && <LapsedBanner canManageBilling={session.permissions.includes('MANAGE_BILLING')} />}
        {showMfaNudge && <MfaRecommendBanner />}
        {children}
        <CommandPalette permissions={session.permissions} portfolio={hasFeature(session.planTier, 'portfolio', !!session.lapsed)} />
        <StepUpHost />
      </main>
    </AppShell>
  )
}
