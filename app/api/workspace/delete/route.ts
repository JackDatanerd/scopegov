// app/api/workspace/delete/route.ts
// FIX 6: After soft-deleting workspace, also deactivate all member rows so
// no one can access the deleted workspace on next login.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { logAudit } from '@/lib/utils/audit'
import { sendWorkspaceDeletedEmail } from '@/lib/email/templates'

export async function DELETE() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    // Block deletion if any signed SOW exists
    const { count: signedSowCount } = await (service as any)
      .from('sow_documents')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'signed')

    if ((signedSowCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with signed documents cannot be deleted. Contact support@scopegov.app.',
      }, { status: 409 })
    }

    // FIX (deep audit, section 5): this guard only ever looked at
    // sow_documents. An accepted change order is just as binding as a
    // signed SOW (change_orders.status can reach 'accepted'), and
    // invoice_payments is a real ledger of money the agency has actually
    // collected from clients — deleting the workspace wiped both with no
    // check at all. Block on either.
    const { count: acceptedCoCount } = await (service as any)
      .from('change_orders')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'accepted')

    if ((acceptedCoCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with accepted change orders cannot be deleted. Contact support@scopegov.app.',
      }, { status: 409 })
    }

    const { count: paymentCount } = await (service as any)
      .from('invoice_payments')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)

    if ((paymentCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with recorded invoice payments cannot be deleted. Contact support@scopegov.app.',
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

    // FIX (deep audit, Workspace lifecycle section): capture the other
    // active members BEFORE deactivating them — every other consequential
    // account-level event in this codebase (MFA changes, password
    // changes) emails the affected person; a team's entire workspace
    // disappearing under them got nothing at all.
    const { data: otherMembers } = await (service as any)
      .from('workspace_members')
      .select('user:users(email, name)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')
      .neq('user_id', session.id)

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

    // Best-effort — must never block the deletion itself, which has
    // already succeeded by this point.
    for (const m of (otherMembers || [])) {
      const u = m?.user
      if (!u?.email) continue
      await sendWorkspaceDeletedEmail({
        to: u.email, name: u.name || u.email,
        agencyName: session.agencyName, deletedByName: session.name,
      }).catch(e => console.error('Workspace deleted email failed (non-fatal):', e))
    }

    // FIX (deep audit, section 5): record the deletion itself in the
    // audit trail — a workspace-ending action had no entry at all.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.deleted', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { billing_cancelled: !!billing?.paystack_subscription_code },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
