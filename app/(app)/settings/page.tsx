import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import SettingsClient from '@/components/settings/SettingsClient'

export const metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()

  const [wsRes, billingRes, defaultsRes] = await Promise.all([
    (service as any)
      .from('workspaces')
      .select('id,name,slug,agency_name,brand_colour,logo_storage_path,industry,currency,timezone,sow_language,governing_law,proactive_risk_threshold,proactive_risk_alerts_enabled,plan_tier,trial_ends_at,created_at')
      .eq('id', session.workspaceId)
      .single(),
    (service as any)
      .from('billing')
      .select('paystack_customer_code,paystack_subscription_code,cancels_at_period_end,current_period_end,payment_method_last4,payment_method_type')
      .eq('workspace_id', session.workspaceId)
      .single(),
    (service as any)
      .from('workspace_defaults')
      .select('*')
      .eq('workspace_id', session.workspaceId)
      .is('project_type', null)
      .single(),
  ])

  // Logo public URL
  let logoUrl: string | null = null
  if (wsRes.data?.logo_storage_path) {
    const { data: u } = await (service as any).storage.from('logos').getPublicUrl(wsRes.data.logo_storage_path)
    logoUrl = u?.publicUrl || null
  }

  return (
    <SettingsClient
      workspace={wsRes.data}
      billing={billingRes.data}
      defaults={defaultsRes.data}
      logoUrl={logoUrl}
      session={session}
      permissions={{
        manageWorkspace: hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'),
        manageBilling:   hasPermission(session, 'MANAGE_BILLING'),
        viewAuditLog:    hasPermission(session, 'VIEW_AUDIT_LOG'),
        exportData:      hasPermission(session, 'EXPORT_DATA'),
        manageRoles:     hasPermission(session, 'MANAGE_ROLES'),
      }}
    />
  )
}
