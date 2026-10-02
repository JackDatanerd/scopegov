// app/api/workspace/transfer-ownership/route.ts
//
// FEATURE GAP (deep audit, Workspace lifecycle + Onboarding re-pass): see
// migration 039 for the full story. There was no way for a workspace's
// creator to hand off `created_by` to someone else — the only "step away"
// option was leaving outright, which migration 038 now blocks for a
// trial-tier workspace's own creator specifically because it was a
// permanent, unrecoverable lockout with no other way out. This route is
// that other way out.
//
// GET returns whether the caller is the current creator and, if so, who
// they can hand ownership to (an active member who already holds
// MANAGE_WORKSPACE_SETTINGS) — the UI needs both to decide what to show.
// POST performs the transfer via transfer_workspace_ownership (039), which
// re-checks everything this route pre-checks; the RPC is the actual
// authority, this route just turns its exceptions into readable errors.

import { sendOwnershipTransferredEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { notifyUsers } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { isUuidString } from '@/lib/utils/uuid'

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    // FIX (Settings independent pass 6 — B3): neither read's error was looked at, so a failed members read answered
    // 200 with an empty list — which the Danger zone words as "no other member holds Manage workspace settings",
    // sending the owner off to change roles for a problem that does not exist. A failed read is now a failure.
    const { data: ws, error: wsErr } = await (service as any)
      .from('workspaces')
      .select('created_by')
      .eq('id', session.workspaceId)
      .maybeSingle()
    if (wsErr) {
      console.error('Transfer-ownership: could not read workspace:', wsErr)
      return NextResponse.json({ error: 'Could not load eligible members. Try again.' }, { status: 500 })
    }

    const isOwner = !!ws && ws.created_by === session.id
    if (!isOwner) return NextResponse.json({ isOwner: false, eligibleMembers: [] })

    const { data: members, error: membersErr } = await (service as any)
      .from('workspace_members')
      .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')
      .neq('user_id', session.id)
    if (membersErr) {
      console.error('Transfer-ownership: could not read members:', membersErr)
      return NextResponse.json({ error: 'Could not load eligible members. Try again.' }, { status: 500 })
    }

    const eligibleMembers = (members || [])
      .filter((m: any) => m.effective_permissions?.MANAGE_WORKSPACE_SETTINGS === true)
      .map((m: any) => ({ id: m.user_id, name: m.users?.name || '', email: m.users?.email || '' }))

    return NextResponse.json({ isOwner: true, eligibleMembers })
  } catch (err) {
    console.error('Transfer-ownership status error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const newOwnerUserId = typeof body?.newOwnerUserId === 'string' ? body.newOwnerUserId : null
    if (!newOwnerUserId) return NextResponse.json({ error: 'newOwnerUserId is required' }, { status: 400 })
    if (!isUuidString(newOwnerUserId)) return NextResponse.json({ error: 'Invalid newOwnerUserId' }, { status: 400 })

    // FIX (Workspace lifecycle independent pass — B1): the target workspace is the session's CURRENT
    // active one, so a stale Settings tab (another tab switched workspaces since it loaded its eligible
    // list) could hand ownership of a different workspace to the person picked for this one. The client
    // now says which workspace it is looking at, same guard as DELETE /api/workspace/delete.
    if (typeof body?.workspaceId !== 'string' || body.workspaceId !== session.workspaceId) {
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    }

    // Handing over a workspace is irreversible by the giver — confirm it's them.
    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

    const service = createServiceClient()

    const { data: newOwner } = await (service as any)
      .from('users').select('name, email').eq('id', newOwnerUserId).maybeSingle()

    const { error } = await (service as any).rpc('transfer_workspace_ownership', {
      p_workspace_id: session.workspaceId,
      p_current_owner_id: session.id,
      p_new_owner_id: newOwnerUserId,
    })

    if (error) {
      const msg = error.message || ''
      if (msg.includes('not_owner'))
        return NextResponse.json({ error: 'Only the current owner can transfer this workspace.' }, { status: 403 })
      if (msg.includes('same_owner'))
        return NextResponse.json({ error: 'That person already owns this workspace.' }, { status: 400 })
      if (msg.includes('target_not_active_member'))
        return NextResponse.json({ error: 'That person is not an active member of this workspace.' }, { status: 400 })
      if (msg.includes('target_lacks_permission'))
        return NextResponse.json({
          error: 'That person needs the "Manage workspace settings" permission before they can become the owner. Grant it under Team > Roles first.',
        }, { status: 400 })
      if (msg.includes('workspace_not_found'))
        return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })

      // The recipient already owns an active trial workspace of their own, and a person may own only one at a time
      // (one_active_trial_per_creator). The function's UPDATE of created_by trips that index; unmapped it surfaced as a
      // generic 500 "try again" that could never succeed on retry. The transaction rolled back, so nothing changed.
      if ((error as any).code === '23505' && msg.includes('one_active_trial_per_creator'))
        return NextResponse.json({
          error: 'That person already owns an active trial workspace, and a person can only own one trial at a time. Upgrade this workspace off the trial plan first, or ask them to upgrade or delete their own trial, then try again.',
        }, { status: 409 })

      console.error('transfer_workspace_ownership failed:', error)
      return NextResponse.json({ error: 'Could not transfer ownership. Try again.' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.ownership_transferred', entityType: 'workspace', entityId: session.workspaceId,
      entityName: session.workspaceName,
      metadata: {
        previous_owner_id: session.id, previous_owner_email: session.email,
        new_owner_id: newOwnerUserId, new_owner_email: newOwner?.email || '',
      },
    }).catch(() => {})

    // FEATURE (Notifications & email fix round): the new owner was never told, and the previous
    // owner got no confirmation. Both are emailed regardless of preferences (a security event);
    // the new owner also gets a bell entry.
    await notifyUsers(service, {
      workspaceId: session.workspaceId, recipientIds: [newOwnerUserId],
      type: 'ownership_transferred', title: 'You are now the workspace owner',
      body: `${session.name} transferred ownership of ${session.workspaceName} to you.`, entityType: 'team',
    })
    const ownerEmails = [session.email, newOwner?.email].filter((e): e is string => !!e)
    if (ownerEmails.length) {
      await checkedSend(() => sendOwnershipTransferredEmail({
        to: ownerEmails, agencyName: session.workspaceName,
        newOwnerName: newOwner?.name || newOwner?.email || 'the new owner', formerOwnerName: session.name,
      }), 'Ownership transferred email')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Transfer-ownership error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
