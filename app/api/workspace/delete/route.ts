// app/api/workspace/delete/route.ts
// FIX 6: After soft-deleting workspace, also deactivate all member rows so
// no one can access the deleted workspace on next login.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelPaystackSubscription, resumePaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { logAudit } from '@/lib/utils/audit'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { sendWorkspaceDeletedEmail } from '@/lib/email/templates'

export async function DELETE(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    // FIX (fresh independent audit, section 4): settings, branding and defaults all refuse
    // (409) when the caller says which workspace it thinks it's acting on and that isn't the
    // session's active one. This route — the most destructive write in the section — never
    // did. The typed-name check below only proves the caller knows the ACTIVE workspace's
    // name, so a stale onboarding tab (another tab/device switched the active workspace to
    // one that happens to share the name — the wizard creates name === agency_name, and
    // 'Acme' is a common choice) would delete the live workspace instead of the discarded
    // one. When the caller names a workspace, it must be the one being deleted.
    const deleteBody = await request.json().catch(() => null) as { confirmName?: unknown; workspaceId?: unknown } | null
    if (deleteBody && deleteBody.workspaceId !== undefined && deleteBody.workspaceId !== session.workspaceId) {
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    }

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

    // FIX (independent pass, Workspace lifecycle + CO logic round): 'changes_requested' was missing
    // from this file's own guards — it is the exact SOW-side counterpart of the CO's 'countered'
    // state, which pendingCoCount below already treats as blocking: the client has acted (requested
    // changes) and it is the AGENCY's turn to revise/resend, exactly as live and unresolved as a SOW
    // sitting 'awaiting_signature'. See app/api/portal/sow/[token]/request-changes/route.ts (what sets
    // it) and cron/sow-expiry (which auto-expires it the same way it does 'awaiting_signature' — proof
    // it's treated as a genuine open state elsewhere in this codebase, just never guarded here). This
    // file's own "NOTE for future re-audits" below claimed the existing guards made a deleted workspace
    // unable to hold a SOW at anything but signed/awaiting_signature — that was never true; a
    // changes_requested SOW slipped through and got permanently stranded (portal shows a generic
    // "revoked" state via isWorkspaceDeleted(), with no way for the agency to ever act on it again,
    // since every member is deactivated by this same delete).
    const { count: pendingSowChangesCount } = await (service as any)
      .from('sow_documents')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'changes_requested')

    if ((pendingSowChangesCount || 0) > 0) {
      return NextResponse.json({
        error: 'Workspaces with a SOW awaiting a revised version cannot be deleted — resolve or withdraw it first. Contact support@scopegov.app if you need help.',
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
    //
    // FIX (deep audit round 2, Workspace lifecycle + CO logic — flagship
    // finding): 'countered' and 'stalled' were missing from this list.
    // Both are just as live/unresolved as 'awaiting_response':
    // 'countered' means the CLIENT made a counter-offer and the AGENCY
    // hasn't accepted or declined it yet (see accept-counter/route.ts,
    // which requires co.status === 'countered' to act on it at all), and
    // 'stalled' is an unanswered 'awaiting_response' CO that co-stall's
    // cron flagged after 5 days — still explicitly client-respondable
    // (see CLIENT_RESPONDABLE_STATUSES in
    // app/api/portal/co/[token]/_actions.ts, and close/route.ts's own
    // TERMINAL_FROM/notification handling for exactly these two states).
    // Since isWorkspaceDeleted() on the portal side returns 'revoked' for
    // ANY status once the workspace is soft-deleted, a workspace could be
    // deleted while a CO sat in either state — permanently stranding an
    // open negotiation with no way for the client to hear back and no way
    // for the agency to ever act on it again (every member gets
    // deactivated by this same delete).
    const { count: pendingCoCount } = await (service as any)
      .from('change_orders')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .in('status', ['awaiting_response', 'awaiting_countersignature', 'countered', 'stalled'])

    if ((pendingCoCount || 0) > 0) {
      return NextResponse.json({
        // FIX (deep audit round 2): message widened to cover 'countered' (awaiting the AGENCY's
        // decision, not the client's) alongside the client-awaited states, now that both block deletion.
        error: 'Workspaces with a change order still in an open negotiation cannot be deleted — close or withdraw it first. Contact support@scopegov.app if you need help.',
      }, { status: 409 })
    }

    const { count: paymentCount } = await (service as any)
      .from('invoice_payments')
      // invoice_payments has no workspace_id column of its own — filtering on one made this query
      // error, the error was ignored, and the count read as 0, so the guard never blocked anything.
      .select('id, invoices!inner(workspace_id)', { count: 'exact', head: true })
      .eq('invoices.workspace_id', session.workspaceId)

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

    // NOTE for future re-audits: combined, the guards above mean a
    // deleted workspace can never have a SOW at 'signed'/'awaiting_signature'/
    // 'changes_requested', a CO at 'accepted'/'awaiting_response'/
    // 'awaiting_countersignature'/'countered'/'stalled', or an invoice at
    // anything but 'draft'/'void'. (An earlier version of this note claimed
    // this already held with only 'signed'/'awaiting_signature' listed for
    // SOW — it didn't: 'changes_requested' slipped through unguarded until
    // the independent pass that added pendingSowChangesCount above. If you're
    // re-auditing this file, verify this list against the guards actually
    // present above rather than trusting this comment on faith.) The portal's
    // *mutating* routes (SOW sign/decline/request-changes, CO accept/counter/
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

    // FIX (Workspace lifecycle independent pass — B2/B9): soft-delete, member
    // deactivation and active-workspace reassignment used to be three separate
    // writes from this route. (1) The soft-delete UPDATE had no `deleted_at IS NULL`
    // guard, so two overlapping DELETEs (double click, retry after a slow response)
    // re-stamped deleted_at with a NEWER value than the one the members were
    // deactivated with; restore matches deactivated_at EXACTLY, so it then
    // reactivated nobody. (2) A failure after the soft-delete left the workspace
    // deleted with every member still 'active' and no rollback. (3) The blocker
    // checks above are reads, not atomic with this write. delete_workspace_atomic
    // (migration 116) does all of it in one transaction under a workspace row lock,
    // re-checks the blockers under that lock, and refuses a second delete.
    const { error: wsDeleteError } = await (service as any)
      .rpc('delete_workspace_atomic', { p_workspace_id: session.workspaceId, p_now: now })
    if (wsDeleteError) {
      const msg = String(wsDeleteError.message || '')
      // Someone (another tab / a retry) already deleted it: the request that won owns
      // the billing cancellation — do NOT resume anything here.
      if (msg.includes('already_deleted') || msg.includes('workspace_not_found')) {
        return NextResponse.json({ error: 'This workspace has already been deleted.' }, { status: 409 })
      }
      console.error('Workspace delete RPC failed:', JSON.stringify(wsDeleteError))
      // The subscription was cancelled above, before the workspace was touched. The delete
      // did not happen, so put billing back the way it was rather than leave a live
      // workspace with a dead subscription (the old message "Nothing was changed" was
      // simply untrue for billing).
      let billingRestored = true
      if (billing?.paystack_subscription_code && !cancelResult.alreadyCancelled) {
        const resumed = await resumePaystackSubscription(billing).catch((e: unknown) => ({ ok: false, error: String(e) }))
        if (!resumed.ok) {
          billingRestored = false
          await alertBillingOps(service, `billing:delete-rollback-resume:${session.workspaceId}`, 'Workspace delete failed after Paystack cancel — subscription NOT resumed', [
            `workspace: ${session.workspaceId}`,
            `delete_workspace_atomic failed: ${msg}`,
            `resume error: ${resumed.error || 'unknown'}`,
            'The workspace is still live but its Paystack subscription is cancelled. Resume it manually.',
          ]).catch(() => {})
        }
      }
      if (msg.includes('blocked_by_live_documents')) {
        return NextResponse.json({
          error: 'This workspace has live documents, open negotiations, unpaid invoices or recorded payments, so it can\u2019t be deleted right now. Refresh and check what changed, or contact support@scopegov.app.',
        }, { status: 409 })
      }
      return NextResponse.json({
        error: billingRestored
          ? 'Failed to delete workspace. Nothing was changed — try again.'
          : 'Failed to delete workspace, and its billing subscription could not be re-enabled automatically. Our team has been alerted — contact support@scopegov.app.',
      }, { status: 500 })
    }

    // FIX (Billing re-pass, independent redo #3 — B3): drop this workspace's
    // unconsumed checkouts. They live 24h and used to survive deletion, so a
    // popup left open and paid afterwards bound a live subscription to a
    // workspace nobody can reach. Best-effort — the webhook also refuses to
    // apply a subscription to a deleted workspace.
    const { error: purgeErr } = await (service as any).from('billing_checkouts').delete()
      .eq('workspace_id', session.workspaceId).is('consumed_at', null)
    if (purgeErr) console.error('Could not purge pending checkouts on workspace delete:', purgeErr.message)

    // Member deactivation and active_workspace_id reassignment (which used to live
    // here as two separate best-effort writes) now happen inside
    // delete_workspace_atomic above, in the same transaction as the soft-delete.

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
