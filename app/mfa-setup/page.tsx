import { getSessionStrict, userHasAnyMfaMandatoryMembershipOrAssume } from '@/lib/auth/session'
import { adminNeedsMfaEnrolment } from '@/lib/auth/admin'
import { redirect } from 'next/navigation'
import { mfaIsEnforced } from '@/lib/auth/mfa-policy'
import MfaSetupClient from '@/components/mfa/MfaSetupClient'
import StepUpHost from '@/components/auth/StepUpHost'
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
  const session = await getSessionStrict()
  const sp = await searchParams

  // FIX (Auth+MFA independent pass 7 — MEDIUM): getSession() is null for anyone with no
  // active workspace, which sent a platform admin with no membership to /login (and from
  // there to /onboarding) — they could never enrol the factor the admin panel requires.
  // Such an admin is let in here without a workspace; anyone else with no session still
  // goes to /login.
  const adminPending = await adminNeedsMfaEnrolment()
  if (!session && !adminPending) redirect('/login')

  // FIX (deep audit, Auth+MFA section): was permissionsRequireMfa(session.permissions),
  // which only reflects the ACTIVE workspace. A user forced here because a
  // NON-active membership mandates MFA saw this as optional and got a "Skip for now"
  // link that just looped them back — see userHasAnyMfaMandatoryMembership.
  const next = session
    ? safeRedirectPath(sp.next)
    : (sp.next && sp.next.startsWith('/admin') ? safeRedirectPath(sp.next) : '/admin')
  // An admin who arrived to open the admin panel can't "skip": /admin would just send
  // them straight back here.
  const mandatory = (mfaIsEnforced() && session ? await userHasAnyMfaMandatoryMembershipOrAssume(session.id) : false)
    || (!!adminPending && next.startsWith('/admin'))
  const userName = session ? session.name : adminPending!.name

  // StepUpHost: /api/auth/mfa/enroll asks for a fresh password confirmation before
  // it starts a first enrolment (see that route) — this page sits outside the (app)
  // and onboarding layouts that normally mount the modal.
  return (
    <>
      <StepUpHost />
      <MfaSetupClient
        mandatory={mandatory}
        next={next}
        recovered={sp.recovered === '1'}
        userName={userName}
      />
    </>
  )
}
