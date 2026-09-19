// app/(app)/settings/page.tsx
// FIX 2: .single() → .maybeSingle() on defaults query.
// When duplicate rows existed, .single() returned a 406 error and data was null,
// making the UI show hardcoded defaults even after a successful save.
// .maybeSingle() returns null gracefully when no row exists, never 406.

import { getSession, hasPermission, userHasAnyMfaMandatoryMembership } from '@/lib/auth/session'
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
      // FIX (deep audit, section 5): this select list omitted tax_id, phone,
      // website, default_payment_instructions, and legal_address — the
      // entire "Billing identity" block that SettingsClient renders and
      // lets people save. workspace/settings/route.ts writes all five
      // correctly; they just never came back on the next page load, so a
      // successful save looked exactly like a failed one (fields render
      // blank again on refresh, even though the data is in Postgres).
      .select('id,name,slug,slug_changed_at,agency_name,brand_colour,logo_storage_path,agency_signature_data,industry,currency,timezone,sow_language,governing_law,proactive_risk_threshold,proactive_risk_alerts_enabled,guardian_sensitivity_tier,plan_tier,trial_ends_at,created_at,created_by,tax_id,phone,website,default_payment_instructions,legal_address,updated_at')
      .eq('id', session.workspaceId)
      .single(),
    (service as any)
      .from('billing')
      // FIX (deep audit, Reports & Audit / Billing re-pass): plan_interval
      // and grace_period_started_at were both missing from this select —
      // plan_interval didn't exist as a column until now (migration 045),
      // and grace_period_started_at was written by the webhook but never
      // read back anywhere, so BillingTab had no way to show an in-app
      // warning during an active payment-failure grace period (see the
      // banner in BillingTab below).
      .select('paystack_customer_code,paystack_subscription_code,cancels_at_period_end,current_period_end,payment_method_last4,payment_method_type,plan_interval,grace_period_started_at')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle(), // billing row may not exist on trial
    (service as any)
      .from('workspace_defaults')
      .select('*')
      .eq('workspace_id', session.workspaceId)
      .is('project_type', null)
      .maybeSingle(), // FIX 2: was .single() — returns null gracefully, never 406
  ])

  // FIX (deep audit, Settings section — missing-column bug): this query's
  // error was never checked. When guardian_sensitivity_tier didn't exist
  // as a column (035_guardian_sensitivity_tier_column.sql), PostgREST
  // errored on the unknown column, wsRes.data came back null, and the
  // entire page silently rendered as if the workspace had no saved
  // settings at all — with nothing in the logs to explain why. Surfacing
  // this doesn't change the render path (workspace still degrades to
  // null exactly as before, since every consumer already handles that),
  // but it means a future schema/query mismatch shows up immediately in
  // server logs instead of masquerading as "the workspace has no data."
  if (wsRes.error) {
    console.error('Settings: failed to load workspace', wsRes.error)
  }

  // FIX (deep audit, Settings section \u2014 stale logo after replacement):
  // the upload path is `${workspaceId}/logo.${ext}` with `upsert: true`,
  // so replacing a PNG with another PNG writes to the *same* object at
  // the *same* public URL. Supabase serves that URL with its default
  // `cache-control: max-age=3600`, so the OLD logo kept being served \u2014
  // in the app, in every generated SOW/CO/Invoice PDF, and in outbound
  // email \u2014 for up to an hour after the change. An earlier pass fixed
  // the different-extension case (cleaning up the stale object), which
  // quietly left the same-extension case \u2014 by far the common one \u2014
  // untouched, because nothing about it LOOKS broken server-side.
  // Version the URL off the workspace's own updated_at (bumped by every
  // branding/logo write) so a replacement busts cache immediately while
  // an unchanged logo still caches normally.
  let logoUrl: string | null = null
  if (wsRes.data?.logo_storage_path) {
    const { data: u } = await (service as any).storage
      .from('logos')
      .getPublicUrl(wsRes.data.logo_storage_path)
    if (u?.publicUrl) {
      const stamp = wsRes.data.updated_at ? new Date(wsRes.data.updated_at).getTime() : Date.now()
      logoUrl = `${u.publicUrl}?v=${stamp}`
    }
  }

  // FIX (deep audit, RLS+permissions re-pass): agency_signature_data,
  // tax_id, legal_address, and default_payment_instructions were fetched
  // unconditionally into `workspace` and passed straight down as a prop
  // to SettingsClient — a Client Component. Even though WorkspaceTab
  // (the only tab that renders these) already bails out early for anyone
  // without MANAGE_WORKSPACE_SETTINGS, the *prop itself* is still
  // serialized into the page's RSC payload and reaches the browser of
  // every visitor to Settings, viewable via dev tools regardless of
  // whether that tab ever renders. Migration 032 closes the equivalent
  // direct-PostgREST vector for these same columns; this closes the
  // app's own over-fetch into an unprivileged user's browser, matching
  // the redaction pattern already used elsewhere in the app.
  const canManageWorkspace = hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')
  const workspace = wsRes.data && !canManageWorkspace
    ? {
        ...wsRes.data,
        agency_signature_data: null,
        tax_id: null,
        legal_address: null,
        default_payment_instructions: null,
      }
    : wsRes.data

  // FIX (deep audit, Auth+MFA re-pass): SettingsClient's AccountTab used to
  // compute this itself via permissionsRequireMfa(session.permissions) —
  // the active-workspace-only check userHasAnyMfaMandatoryMembership was
  // written to replace everywhere else (mfa-setup's badge, DELETE
  // /api/auth/mfa/factors' guard, change-password's aal2 gate). Computed
  // here now, the same way, so Settings' "MFA mandatory" badge and its
  // Disable-button gating agree with what the server will actually
  // enforce for a mandatory-MFA role held in a non-active workspace.
  const mfaMandatory = await userHasAnyMfaMandatoryMembership(session.id)

  // FIX (deep audit, Settings section \u2014 the redaction above, not applied
  // to its neighbour): the `workspace` block directly above exists because
  // a prop handed to a Client Component is serialized into the page's RSC
  // payload and reaches the browser of EVERY visitor to /settings,
  // readable in dev tools, regardless of whether the tab that consumes it
  // ever renders. That reasoning applies verbatim to `billing`, which was
  // passed down untouched three lines later: paystack_customer_code,
  // paystack_subscription_code, payment_method_last4/type and
  // grace_period_started_at all shipped to members without MANAGE_BILLING
  // \u2014 the same people for whom BillingTab renders <Restricted />. Same
  // page, same class, same fix shape; it just never got applied here.
  const canManageBilling = hasPermission(session, 'MANAGE_BILLING')
  const billing = billingRes.data && !canManageBilling ? null : billingRes.data

  return (
    <SettingsClient
      workspace={workspace}
      billing={billing}
      defaults={defaultsRes.data}
      logoUrl={logoUrl}
      session={session}
      mfaMandatory={mfaMandatory}
      permissions={{
        manageWorkspace: canManageWorkspace,
        manageBilling:   canManageBilling,
        viewAuditLog:    hasPermission(session, 'VIEW_AUDIT_LOG'),
        // FIX (deep audit, section 5 re-pass): EXPORT_DATA removed — see
        // lib/supabase/types.ts for why; it never gated anything.
        manageRoles:     hasPermission(session, 'MANAGE_ROLES'),
      }}
    />
  )
}
