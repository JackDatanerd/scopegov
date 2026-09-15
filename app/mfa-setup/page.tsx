import { getSession, userHasAnyMfaMandatoryMembership } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import MfaSetupClient from '@/components/mfa/MfaSetupClient'
// FIX (section-by-section re-audit): `next` used to be passed through raw.
// LoginForm.tsx, app/mfa-challenge/page.tsx, and api/auth/callback/route.ts
// all validate `next` with safeRedirectPath() before using it — this page
// was the one place that didn't, and MfaSetupClient hands it straight to
// router.push(next), which performs a real navigation for absolute URLs
// with no userinfo trick needed at all. Same open-redirect class, just
// easier to trigger.
import { safeRedirectPath } from '@/lib/utils/safe-redirect'

interface Props {
  searchParams: Promise<{ next?: string; recovered?: string }>
}

export default async function MfaSetupPage({ searchParams }: Props) {
  const session = await getSession()
  if (!session) redirect('/login')

  const sp = await searchParams
  // FIX (deep audit, Auth+MFA section): was permissionsRequireMfa(session.permissions),
  // which only reflects the ACTIVE workspace. A user forced here because a
  // NON-active membership mandates MFA saw this as optional and got a "Skip
  // for now" link that just looped them back — see userHasAnyMfaMandatoryMembership.
  const mandatory = await userHasAnyMfaMandatoryMembership(session.id)

  return (
    <MfaSetupClient
      mandatory={mandatory}
      next={safeRedirectPath(sp.next)}
      recovered={sp.recovered === '1'}
      userName={session.name}
    />
  )
}
