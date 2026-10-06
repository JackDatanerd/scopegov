import { redirect } from 'next/navigation'
import { getSessionStrict } from '@/lib/auth/session'
import Sidebar from '@/components/layout/Sidebar'
import CommandPalette from '@/components/layout/CommandPalette'
import StepUpHost from '@/components/auth/StepUpHost'
import Link from 'next/link'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionStrict()
  if (!session) redirect('/login')
  if (!session.onboardingCompletedAt) redirect('/onboarding')

  return (
    <div className="app">
      <Sidebar session={session} />
      <main className="app-main">
        {session.lapsed && (
          <div className="banner banner-danger" role="status" style={{ margin: '12px 24px 0' }}>
            <span>
              <strong>This workspace is read-only.</strong>
              {' '}{session.permissions.includes('MANAGE_BILLING')
                ? 'Its trial or subscription has ended. Your data is untouched and can still be viewed and exported — choose a plan to create and send again.'
                : 'Its trial or subscription has ended. Ask a workspace admin with billing access to choose a plan. Your data is untouched and can still be viewed and exported.'}
            </span>
            {session.permissions.includes('MANAGE_BILLING') && (
              <Link href="/settings?tab=billing"><button className="btn btn-primary btn-sm">Choose a plan</button></Link>
            )}
          </div>
        )}
        {children}
        <CommandPalette permissions={session.permissions} />
        <StepUpHost />
      </main>
    </div>
  )
}
