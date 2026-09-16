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
    // FIX (round 3, Workspace lifecycle Finding 2 — CRITICAL): the result
    // of this call used to be discarded entirely, defeating the whole
    // point of the comment above — a Paystack failure (unreachable API,
    // declined cancellation) silently fell through to soft-deleting the
    // workspace anyway, leaving a live, still-renewing subscription with
    // no workspace left to manage it from. Now actually checked.
    const cancelResult = await cancelPaystackSubscription(billing)
    if (!cancelResult.ok) {
      console.error('Workspace delete blocked — Paystack cancellation failed:', cancelResult.error)
      return NextResponse.json({
        error: cancelResult.error || 'Could not cancel this workspace\u2019s billing subscription. Try again, or contact support@scopegov.app.',
      }, { status: 502 })
    }

    const now = new Date().toISOString()

    // FIX (deep audit, Workspace lifecycle section): capture the other
    // active members BEFORE deactivating them — every other consequential
    // account-level event in this codebase (MFA changes, password
    // changes) emails the affected person; a team's entire workspace
    // disappearing under them got nothing at all.
    // FIX (round 3, Workspace lifecycle Finding 4): also select user_id now
    // (previously only the embedded user's email/name) and include the
    // ACTOR too — needed below to reassign active_workspace_id for every
    // affected member, not just to email the others.
    const { data: allMembers } = await (service as any)
      .from('workspace_members')
      .select('user_id, user:users(email, name)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')
    const otherMembers = (allMembers || []).filter((m: any) => m.user_id !== session.id)

    // Soft delete workspace
    // FIX (round 3, Workspace lifecycle Finding 3): this write's result was
    // previously discarded — a failure here (RLS, transient DB error) left
    // the route returning { ok: true } while nothing had actually changed.
    const { error: wsDeleteError } = await (service as any)
      .from('workspaces')
      .update({ deleted_at: now })
      .eq('id', session.workspaceId)
    if (wsDeleteError) {
      console.error('Workspace soft-delete failed:', wsDeleteError)
      return NextResponse.json({ error: 'Failed to delete workspace. Nothing was changed — try again.' }, { status: 500 })
    }

    // FIX 6: Deactivate all memberships so getSession() finds no active row
    // on next login — prevents the deleted workspace from being accessible.
    // FIX (round 3, Workspace lifecycle Finding 3): same unchecked-write gap
    // as above — a failure here previously left the workspace soft-deleted
    // but every membership still 'active', silently, with the client told
    // deletion succeeded.
    const { error: deactivateError } = await (service as any)
      .from('workspace_members')
      .update({ status: 'deactivated' })
      .eq('workspace_id', session.workspaceId)
      .neq('status', 'deactivated')
    if (deactivateError) {
      console.error('Workspace member deactivation failed after soft-delete:', deactivateError)
      return NextResponse.json({
        error: 'Workspace was deleted but some memberships could not be deactivated. Contact support@scopegov.app.',
      }, { status: 500 })
    }

    // FIX (round 3, Workspace lifecycle Finding 4): leave_workspace_atomic
    // (migration 027) reassigns the leaver's active_workspace_id to a
    // fallback workspace when their active workspace membership ends —
    // delete had no equivalent for ANY of the members it just deactivated
    // (including the actor). Their active_workspace_id kept pointing at the
    // now-deleted workspace forever. getSession() tolerates this fine (it
    // falls back to the oldest remaining active membership), but
    // workspace/list.ts's `active` flag is a direct equality check with no
    // such fallback, so the workspace switcher showed NO workspace as
    // active at all for every affected member until they manually
    // switched. Best-effort, sequential (this route is single-actor and
    // admin-gated, so the same TOCTOU concern that justified an RPC for
    // leave/route.ts doesn't apply here) — must never block the deletion
    // itself, which has already succeeded by this point.
    for (const m of (allMembers || [])) {
      try {
        const { data: u } = await (service as any)
          .from('users').select('active_workspace_id').eq('id', m.user_id).maybeSingle()
        if (u?.active_workspace_id !== session.workspaceId) continue
        const { data: fallback } = await (service as any)
          .from('workspace_members')
          .select('workspace_id')
          .eq('user_id', m.user_id).eq('status', 'active')
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        await (service as any)
          .from('users').update({ active_workspace_id: fallback?.workspace_id ?? null }).eq('id', m.user_id)
      } catch (e) { console.error('active_workspace_id reassignment failed (non-fatal):', m.user_id, e) }
    }

    // Best-effort — must never block the deletion itself, which has
    // already succeeded by this point.
    for (const m of otherMembers) {
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
