import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClientsClient from '@/components/clients/ClientsClient'

export const metadata = { title: 'Clients' }

export default async function ClientsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()
  const { data: clients = [] } = await (service as any)
    .from('clients')
    .select(`id, name, company_name, email, phone, status, created_at,
      projects(id, status, contract_value, currency)`)
    .eq('workspace_id', session.workspaceId)
    .order('name')

  return (
    <ClientsClient
      clients={clients || []}
      canCreate={hasPermission(session, 'CREATE_PROJECTS')}
      canViewFinancials={hasPermission(session, 'VIEW_FINANCIALS')}
      canViewClientData={hasPermission(session, 'VIEW_CLIENT_DATA')}
    />
  )
}
