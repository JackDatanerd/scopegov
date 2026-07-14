// app/(app)/settings/page.tsx
// FIX 2: .single() → .maybeSingle() on defaults query.
// When duplicate rows existed, .single() returned a 406 error and data was null,
// making the UI show hardcoded defaults even after a successful save.
// .maybeSingle() returns null gracefully when no row exists, never 406.

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
      .select('id,name,slug,slug_changed_at,agency_name,brand_colour,logo_storage_path,agency_signature_data,industry,currency,timezone,sow_language,governing_law,proactive_risk_threshold,proactive_risk_alerts_enabled,guardian_sensitivity_tier,plan_tier,trial_ends_at,created_at')
      .eq('id', session.workspaceId)
      .single(),
    (service as any)
      .from('billing')
      .select('paystack_customer_code,paystack_subscription_code,cancels_at_period_end,current_period_end,payment_method_last4,payment_method_type')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle(), // billing row may not exist on trial
    (service as any)
      .from('workspace_defaults')
      .select('*')
      .eq('workspace_id', session.workspaceId)
      .is('project_type', null)
      .maybeSingle(), // FIX 2: was .single() — returns null gracefully, never 406
  ])

  let logoUrl: string | null = null
  if (wsRes.data?.logo_storage_path) {
    const { data: u } = await (service as any).storage
      .from('logos')
      .getPublicUrl(wsRes.data.logo_storage_path)
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
