// app/api/workspace/delete/route.ts
// FIX 6: After soft-deleting workspace, also deactivate all member rows so
// no one can access the deleted workspace on next login.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'

export async function DELETE() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    // Block deletion if any signed SOW exists
    const { count } = await (service as any)
      .from('sow_documents')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'signed')

    if ((count || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with signed documents cannot be deleted. Contact support@scopegov.app.',
      }, { status: 409 })
    }

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 1 —
    // CRITICAL): deletion never cancelled the workspace's Paystack
    // subscription — it kept renewing/charging indefinitely with no
    // workspace left to manage it from. Cancel before soft-deleting so a
    // failure here (Paystack unreachable, etc.) still surfaces before the
    // workspace becomes inaccessible; cancelPaystackSubscription() itself
    // is a no-op + logged-only-on-failure if there's no active
    // subscription or the call fails, matching billing/cancel's own
    // best-effort handling.
    const { data: billing } = await (service as any)
      .from('billing')
      .select('paystack_subscription_code, paystack_email_token')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    await cancelPaystackSubscription(billing)

    const now = new Date().toISOString()

    // Soft delete workspace
    await (service as any)
      .from('workspaces')
      .update({ deleted_at: now })
      .eq('id', session.workspaceId)

    // FIX 6: Deactivate all memberships so getSession() finds no active row
    // on next login — prevents the deleted workspace from being accessible.
    await (service as any)
      .from('workspace_members')
      .update({ status: 'deactivated' })
      .eq('workspace_id', session.workspaceId)
      .neq('status', 'deactivated')

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
