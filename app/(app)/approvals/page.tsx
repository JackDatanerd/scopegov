// app/(app)/approvals/page.tsx
import { getSession, hasPermission } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import ApprovalsClient from '@/components/approvals/ApprovalsClient'

export const metadata = { title: 'Approvals' }

export default async function ApprovalsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <ApprovalsClient
      session={session}
      canViewAll={hasPermission(session, 'VIEW_ALL_PROJECTS') || hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')}
      canManageWorkflows={hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')}
    />
  )
}
