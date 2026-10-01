// app/(app)/approvals/page.tsx
import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import ApprovalsClient from '@/components/approvals/ApprovalsClient'

export const metadata = { title: 'Approvals' }

export default async function ApprovalsPage() {
  const session = await getSessionStrict()
  if (!session) redirect('/login')

  return (
    <ApprovalsClient
      session={session}
      canViewAll={hasPermission(session, 'VIEW_ALL_PROJECTS') || hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')}
      canManageWorkflows={hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')}
      canApprove={hasPermission(session, 'APPROVE_DOCUMENTS')}
    />
  )
}
