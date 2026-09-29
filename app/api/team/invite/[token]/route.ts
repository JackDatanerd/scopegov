// app/api/team/invite/[token]/route.ts
// Fix: added distinct `alreadyAccepted: true` flag for status === 'active'
// so the frontend can show "already used, sign in" instead of generic "expired".

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { inviterMayStillGrant } from '@/lib/utils/invite-authority'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { effectivePlanTier } from '@/lib/billing/plans'

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()

    // FIX (Team & Invites round 16 — B4): .single() reported ANY failure (a transient DB error included) as
    // "Invalid invite token" (404), which the page renders as "Invite link expired". Only a genuine miss is a 404.
    const { data: member, error: readErr } = await (service as any)
      .from('workspace_members')
      .select(`
        id, status, invite_token_expires_at, invited_email, user_id,
        workspace_id, invited_by, role_id,
        workspaces (id, name, agency_name, deleted_at, plan_tier, trial_ends_at),
        invited_by_user:users!workspace_members_invited_by_fkey (name)
      `)
      .eq('invite_token', token)
      .maybeSingle()

    if (readErr) {
      console.error('Invite validation read failed:', readErr)
      return NextResponse.json({ error: 'Error validating invite' }, { status: 500 })
    }
    if (!member) return NextResponse.json({ error: 'Invalid invite token', invalid: true }, { status: 404 })

    // Fix: status === 'active' means signup already succeeded (invite_token
    // was cleared) — distinguish this from a genuinely expired/deactivated
    // token so the frontend can send the user to sign in instead of showing
    // a dead-end "expired" message.
    if (member.status === 'active') {
      return NextResponse.json({ error: 'Invite already accepted', expired: true, alreadyAccepted: true })
    }
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // already correctly blocked a 'deactivated' row, but not one still
    // sitting at 'invited' whose WORKSPACE has since been soft-deleted —
    // workspace/delete/route.ts does deactivate pending invite rows too,
    // but only ones that existed at the moment of deletion; belt-and-
    // braces against any other path that could leave an invite pointed at
    // a gone workspace. Matches the same check just added to accept/route.ts
    // and signup/route.ts, which actually process acceptance.
    if (member.status === 'deactivated' || member.workspaces?.deleted_at) {
      return NextResponse.json({ error: 'Invite no longer valid', expired: true })
    }

    const expires = new Date(member.invite_token_expires_at)
    if (expires < new Date()) {
      return NextResponse.json({ error: 'Invite expired', expired: true })
    }

    // FIX (round 16 — B4): accept/signup refuse an invite whose sender can no longer grant the role, or whose
    // workspace is full for its plan — but this page used to show a normal "create your account" form and let the
    // invitee fill it in before finding out. Say so up front (same predicates as accept/signup).
    if (!(await inviterMayStillGrant(service, member.workspace_id, member.invited_by, member.role_id))) {
      return NextResponse.json({
        error: 'Invite can no longer be used', expired: true,
        reason: 'The person who sent this invite can no longer grant this role. Ask a workspace admin to send you a new invitation.',
      })
    }
    const seatCheck = await checkSeatLimit(service, member.workspace_id, effectivePlanTier(member.workspaces?.plan_tier, member.workspaces?.trial_ends_at), ['active'])
    if (!seatCheck.ok) {
      return NextResponse.json({
        error: 'Workspace full', expired: true,
        reason: 'This workspace is currently full for its plan. Ask a workspace admin to free up a seat or upgrade the plan, then open this link again.',
      })
    }

    let inviteEmail = member.invited_email || ''
    if (!inviteEmail && member.user_id) {
      const { data: u } = await (service as any)
        .from('users').select('email').eq('id', member.user_id).single()
      inviteEmail = u?.email || ''
    }

    const hasAccount = !!member.user_id

    return NextResponse.json({
      invite: {
        email:         inviteEmail,
        workspaceName: member.workspaces?.name,
        agencyName:    member.workspaces?.agency_name,
        inviterName:   member.invited_by_user?.name || 'Your team',
      },
      hasAccount,
      memberId: member.id,
    })
  } catch (err) {
    console.error('Invite validation error:', err)
    return NextResponse.json({ error: 'Error validating invite' }, { status: 500 })
  }
}
