import { redirect } from 'next/navigation'
import { getSessionStrict } from '@/lib/auth/session'
import Sidebar from '@/components/layout/Sidebar'
import CommandPalette from '@/components/layout/CommandPalette'
import StepUpHost from '@/components/auth/StepUpHost'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionStrict()
  if (!session) redirect('/login')
  if (!session.onboardingCompletedAt) redirect('/onboarding')

  return (
    <div className="app">
      <Sidebar session={session} />
      <main className="app-main">
        {children}
        <CommandPalette permissions={session.permissions} />
        <StepUpHost />
      </main>
    </div>
  )
}
