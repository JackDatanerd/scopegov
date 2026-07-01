import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import Sidebar from '@/components/layout/Sidebar'
import CommandPalette from '@/components/layout/CommandPalette'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!session.onboardingCompletedAt) redirect('/onboarding')

  return (
    <div className="app">
      <Sidebar session={session} />
      <main className="app-main">
        {children}
        <CommandPalette />
      </main>
    </div>
  )
}
