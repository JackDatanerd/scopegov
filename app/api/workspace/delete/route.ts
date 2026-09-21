// app/api/workspace/delete/route.ts
// FIX 6: After soft-deleting workspace, also deactivate all member rows so
// no one can access the deleted workspace on next login.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession, hasPermission, pickFallbackMembership } from '@/lib/auth/session'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { logAudit } from '@/lib/utils/audit'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { sendWorkspaceDeletedEmail } from '@/lib/email/templates'

export async function DELETE(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    // FIX (RLS+permissions audit round 2): this was gated on MANAGE_WORKSPACE_SETTINGS
    // alone — a permission routinely delegated to a co-admin — with no ownership
    // check, no typed confirmation server-side and no step-up, yet it cancels the
    // Paystack subscription and deactivates every member. Deleting the workspace is
    // an OWNER action (workspace/restore is already owner-only, and the UI only
    // shows the button to the owner). If the owner is no longer an active member
    // (they left after handing over, or the account was deleted) a settings admin
    // may still do it, otherwise nobody could ever remove the workspace.
    const { data: wsOwnerRow } = await (service as any)
      .from('workspaces').select('created_by').eq('id', session.workspaceId).maybeSingle()
    const ownerId: string | null = wsOwnerRow?.created_by ?? null
    if (ownerId && ownerId !== session.id) {
      const { data: ownerMember } = await (service as any)
        .from('workspace_members').select('id')
        .eq('workspace_id', session.workspaceId).eq('user_id', ownerId).eq('status', 'active').maybeSingle()
      if (ownerMember) {
        return NextResponse.json({
          error: 'Only the workspace owner can delete it. Ask the owner, or have them transfer ownership to you first.',
        }, { status: 403 })
      }
    }

    // The client's type-the-name box is a UX guard; enforce it where it can't be skipped.
    const deleteBody = await request.json().catch(() => null) as { confirmName?: unknown } | null
    const expectedName = (session.workspaceName || '').trim()
    if (!expectedName || typeof deleteBody?.confirmName !== 'string' || deleteBody.confirmName.trim() !== expectedName) {
      return NextResponse.json({ error: 'Type the workspace name to confirm deletion.' }, { status: 400 })
    }

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

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

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): a SOW
    // still 'awaiting_signature' didn't block deletion at all — combined
    // with the portal sign route having no workspace.deleted_at check
    // (now fixed, see isWorkspaceDeleted in lib/utils/workspace-secret.ts),
    // an agency could delete a workspace out from under a client who was
    // mid-review and the client could still go ahead and sign it
    // afterward. That specific race is closed now on the portal side, but
    // blocking here too means the agency actually has to withdraw or wait
    // out a pending SOW first — the same "resolve it, don't just vanish"
    // discipline the signed-SOW guard above already enforces.
    const { count: pendingSowCount } = await (service as any)
      .from('sow_documents')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'awaiting_signature')

    if ((pendingSowCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with a SOW still awaiting the client\u2019s signature cannot be deleted — withdraw it first. Contact support@scopegov.app if you need help.',
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

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): same gap
    // as pendingSowCount above, for change orders — 'awaiting_response'
    // (not yet responded to) and 'awaiting_countersignature' (agency
    // already accepted the client's counter-offer; only the client's
    // final countersign is outstanding) didn't block deletion, and the
    // client's accept/counter/countersign links had no deleted_at check
    // on the portal side either (also fixed now).
    const { count: pendingCoCount } = await (service as any)
      .from('change_orders')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .in('status', ['awaiting_response', 'awaiting_countersignature'])

    if ((pendingCoCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with a change order still awaiting the client\u2019s response cannot be deleted — withdraw it first. Contact support@scopegov.app if you need help.',
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

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the
    // invoice_payments check above only catches money already collected
    // ('paid'/'partially_paid' invoices, which necessarily have a payment
    // row). An invoice sitting at 'sent' or 'overdue' — a real, live
    // financial claim on a client, just with nothing paid against it yet
    // — sailed straight through. Deleting the workspace left that
    // obligation stranded: the client's portal link (now also fixed to
    // check deleted_at) would otherwise have kept showing payment
    // instructions with no agency member left active to manage or record
    // whatever the client actually pays.
    const { count: outstandingInvoiceCount } = await (service as any)
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .in('status', ['sent', 'overdue'])

    if ((outstandingInvoiceCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with an outstanding unpaid invoice cannot be deleted — void it first if it\u2019s no longer owed. Contact support@scopegov.app if you need help.',
      }, { status: 409 })
    }

    // NOTE for future re-audits: combined, the four guards above mean a
    // deleted workspace can never have a SOW at 'signed'/'awaiting_signature',
    // a CO at 'accepted'/'awaiting_response'/'awaiting_countersignature', or
    // an invoice at anything but 'draft'/'void'. The portal's *mutating*
    // routes (SOW sign/decline/request-changes, CO accept/counter/
    // countersign/decline) each still carry their own explicit
    // isWorkspaceDeleted() check (belt-and-suspenders — see that
    // function's comment in lib/utils/workspace-secret.ts), since those
    // create new state. The three read-only document views/downloads
    // (SOW pdf, CO pdf, invoice route+dispute+pdf) only ever serve
    // documents in exactly the statuses these guards already keep out of
    // deleted workspaces, so they're unreachable in the vulnerable state
    // by construction — don't "fix" them by bolting on a redundant check
    // without first checking whether one of the guards above moved.

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
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
    // gap): this write never stamped deactivated_at (unlike
    // leave_workspace_atomic's own deactivation, which always does) —
    // harmless on its own, but restore_workspace_atomic (migration 065,
    // the new workspace-restore feature) needs to tell "deactivated BY
    // THIS deletion" apart from "was already deactivated for an unrelated
    // reason before the deletion happened" so a restore can't accidentally
    // resurrect someone who'd genuinely left or been removed earlier.
    // Stamping it with the exact same `now` used for the workspace's own
    // deleted_at just below gives restore an exact, reliable match.
    const { error: deactivateError } = await (service as any)
      .from('workspace_members')
      .update({ status: 'deactivated', deactivated_at: now })
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
        // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
        // flagship finding): this used to grab only the single oldest
        // remaining active membership, with no regard for whether THAT
        // workspace had actually finished onboarding — see
        // pickFallbackMembership's own comment in lib/auth/session.ts for
        // the full story and the other three call sites sharing this exact
        // gap. Concretely reachable via the onboarding wizard's own
        // "Discard this workspace" button: an invited member sitting on
        // the 'waiting' screen for THIS workspace could get reassigned
        // into some other older-but-still-incomplete workspace of theirs
        // instead of a perfectly usable, already-onboarded one. Fetch a
        // real candidate set and prefer a completed workspace.
        const { data: candidates } = await (service as any)
          .from('workspace_members')
          .select('workspace_id, workspaces(deleted_at, onboarding_completed_at)')
          .eq('user_id', m.user_id).eq('status', 'active')
          .order('created_at', { ascending: true }).limit(25)
        const fallback = pickFallbackMembership(candidates)
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
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the
    // outer catch-all here still returned a raw exception message
    // verbatim — every specific, expected failure branch above this
    // point was already hardened against exactly this (Paystack errors,
    // the soft-delete write, the deactivation write all log server-side
    // and return a generic message), but an unexpected exception (a
    // network-level Supabase client error, a malformed request) fell
    // through this fallback and leaked internals anyway.
    console.error('Workspace delete error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
